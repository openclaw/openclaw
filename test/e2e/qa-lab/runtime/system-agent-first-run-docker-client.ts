// OpenClaw first-run Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { shouldStartOnboardingForFreshInstall } from "../../../../dist/cli/run-main.js";
import { runGuidedOnboarding } from "../../../../dist/commands/onboard-guided.js";
import { clearConfigCache } from "../../../../dist/config/config.js";
import type { OpenClawConfig } from "../../../../dist/config/types.openclaw.js";
import { createSqliteAuditRecordStore } from "../../../../dist/infra/sqlite-audit-record-store.js";
import type { RuntimeEnv } from "../../../../dist/runtime.js";
import {
  beginLocalOnboarding,
  readLocalOnboardingStateForConfig,
} from "../../../../dist/state/local-onboarding-state.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../../../../dist/system-agent/audit.js";
import {
  activateSetupInference,
  verifySetupInference,
} from "../../../../dist/system-agent/setup-inference.js";
import { runSystemAgent } from "../../../../dist/system-agent/system-agent.js";
import { createE2eStateDir } from "../../../../scripts/e2e/lib/temp-state-dir.ts";

type SystemAgentFirstRunCommand = {
  id: string;
  message: string;
  expectOutput: string;
  approve: boolean;
  planner?: boolean;
};

type SystemAgentFirstRunSpec = {
  dockerDefaultWorkspace: string;
  dockerAgentWorkspace: string;
  agentId: string;
  model: string;
  telegramEnv: string;
  telegramToken: string;
  commands: SystemAgentFirstRunCommand[];
  auditOperations: string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function setEnvValue(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}

function createRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

async function readFirstRunSpec(): Promise<SystemAgentFirstRunSpec> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "scripts", "e2e", "system-agent-first-run-spec.json"),
      "utf8",
    ),
  ) as SystemAgentFirstRunSpec;
}

function renderCommandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => vars[key] ?? match);
}

const FAKE_PLANNER_REPLY = "Fake Claude planner selected an inference-backed typed setup.";
const PACKAGED_CLI_TIMEOUT_MS = 60_000;
const INFERENCE_PROBE_PROMPT = "Reply with the single word OK";
const EXPECTED_PERSISTED_MODEL = "anthropic/claude-opus-5";
const GUIDED_SETUP_INTERRUPTION = "first-run fixture interrupted before setup apply";
const DISCORD_CREDENTIAL_ENV = ["DISCORD", "BOT", "TOKEN"].join("_");
const DISCORD_CREDENTIAL_FIXTURE = ["openclaw", "discord", "fixture"].join("-");

type PackagedCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function readFakeClaudePromptLines(promptLogPath: string): Promise<string[]> {
  return (await fs.readFile(promptLogPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function countInferencePrompts(lines: string[]): number {
  return lines.filter((line) => line.includes(INFERENCE_PROBE_PROMPT)).length;
}

function resolveDefaultModel(config: OpenClawConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

async function installFakeClaudeCli(
  fakeBinDir: string,
  promptLogPath: string,
  plannerCommand: string,
): Promise<void> {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const packageRoot = path.dirname(fakeBinDir);
  const scriptPath = path.join(fakeBinDir, "claude");
  const plannerResult = JSON.stringify({
    reply: FAKE_PLANNER_REPLY,
    command: plannerCommand,
  });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@anthropic-ai/claude-code",
      version: "99.0.0",
      private: true,
      bin: { claude: "bin/claude" },
    })}\n`,
  );
  await fs.writeFile(
    scriptPath,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'if (process.argv[2] === "--version") {',
      '  console.log("claude 99.0.0");',
      "  process.exit(0);",
      "}",
      `const promptLogPath = ${JSON.stringify(promptLogPath)};`,
      `const plannerResult = ${JSON.stringify(plannerResult)};`,
      'const promptLine = fs.readFileSync(0, "utf8").split(/\\r?\\n/u, 1)[0] ?? "";',
      'fs.appendFileSync(promptLogPath, `${promptLine}\\n`, "utf8");',
      'const result = promptLine.includes("User request:") ? plannerResult : "OK";',
      "console.log(",
      "  JSON.stringify({",
      '    type: "result",',
      '    session_id: "fake-claude-session",',
      "    result,",
      "    usage: { input_tokens: 1, output_tokens: 1 },",
      "  }),",
      ");",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(scriptPath, 0o755);
}

async function runPackagedCli(args: string[]): Promise<PackagedCommandResult> {
  const child = spawn("openclaw", args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PACKAGED_CLI_TIMEOUT_MS);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    throw new Error(
      `Packaged CLI timed out after ${PACKAGED_CLI_TIMEOUT_MS}ms: openclaw ${args.join(" ")}\n${stdout}\n${stderr}`,
    );
  }
  return { code, stdout, stderr };
}

async function runPackagedOneShot(
  message: string,
  approve: boolean,
): Promise<PackagedCommandResult> {
  clearConfigCache();
  const { runtime, lines } = createRuntime();
  try {
    // Entrypoint, fail-closed, and planner checks stay real CLI subprocesses.
    // Supporting typed operations share the package process so their repeated
    // full CLI bootstrap cannot dominate this focused operation lane.
    const inference = await verifySetupInference({ runtime, bindSession: true });
    assert(inference.ok, `packaged inference verification failed: ${JSON.stringify(inference)}`);
    await runSystemAgent({ message, yes: approve, verifiedInference: inference.binding }, runtime);
    return { code: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    return { code: 1, stdout: lines.join("\n"), stderr: String(error) };
  }
}

async function runReleasedPendingRecovery(inferenceConfig: OpenClawConfig) {
  const state = await createE2eStateDir("openclaw-released-pending-", {});
  assert(state.created, "released fixture requires its own state directory");
  state.registerExitCleanup();
  const configPath = path.join(state.stateDir, "openclaw.json");
  const workspace = path.join(state.stateDir, "approved-workspace");
  setEnvValue("OPENCLAW_STATE_DIR", state.stateDir);
  setEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  clearConfigCache();
  const defaults = { ...inferenceConfig.agents?.defaults };
  delete defaults.models;
  // v2026.9.4 (3a9d69db) wrote this runtime-bearing main entry after claiming
  // the receipt, before workspace setup. Do not recreate the retired producer.
  const main = {
    default: true,
    models: { [EXPECTED_PERSISTED_MODEL]: { agentRuntime: { id: "claude-cli" } } },
  };
  const releasedConfig: OpenClawConfig = {
    ...structuredClone(inferenceConfig),
    agents: { defaults, entries: { main } },
  };
  const securityAcknowledgedAt = releasedConfig.wizard?.securityAcknowledgedAt;
  assert(
    securityAcknowledgedAt &&
      releasedConfig.agents?.defaults?.workspace === undefined &&
      releasedConfig.gateway === undefined &&
      resolveDefaultModel(releasedConfig) === EXPECTED_PERSISTED_MODEL,
    "released pending fixture does not match the interrupted inference state",
  );
  await fs.writeFile(configPath, `${JSON.stringify({ wizard: releasedConfig.wizard })}\n`);
  const claimed = beginLocalOnboarding({
    configPath,
    workspace,
    securityAcknowledgedAt,
    runId: "released-interrupted-setup",
  });
  await fs.writeFile(configPath, `${JSON.stringify(releasedConfig, null, 2)}\n`);
  const before = readLocalOnboardingStateForConfig(configPath, releasedConfig);
  assert(
    before?.status === "pending" &&
      before.runId === claimed.runId &&
      before.workspace === workspace &&
      before.teamCoordinatorId === undefined &&
      before.securityAcknowledgedAt === securityAcknowledgedAt,
    "released pending fixture did not retain its approved owner",
  );
  console.log("OpenClaw released pending recovery preconditions passed");

  // The current installed CLI owns workspace publication and receipt completion.
  const result = await runPackagedCli([
    "setup",
    "--message",
    `setup workspace ${workspace}`,
    "--yes",
  ]);
  clearConfigCache();
  const after = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const owner = readLocalOnboardingStateForConfig(configPath, after);
  const mainPreserved = isDeepStrictEqual(after.agents?.entries, { main });
  console.log(
    `OpenClaw released pending recovery state: ${JSON.stringify({
      status: owner?.status,
      sameOwner: owner?.runId === claimed.runId,
      approvedWorkspace: workspace,
      receiptWorkspace: owner?.workspace,
      defaultWorkspace: after.agents?.defaults?.workspace ?? null,
      mainPreserved,
      model: resolveDefaultModel(after),
      runtime: after.agents?.entries?.main?.models?.[EXPECTED_PERSISTED_MODEL]?.agentRuntime?.id,
    })}`,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert(
    result.code === 0 && output.includes("[openclaw] done: openclaw.setup"),
    `OpenClaw released pending recovery did not apply: ${output}`,
  );
  assert(
    owner?.status === "completed" &&
      owner.runId === claimed.runId &&
      owner.workspace === workspace &&
      owner.securityAcknowledgedAt === securityAcknowledgedAt &&
      after.agents?.defaults?.workspace === workspace &&
      mainPreserved &&
      resolveDefaultModel(after) === EXPECTED_PERSISTED_MODEL,
    "released pending recovery did not preserve runtime identity and complete its approved root",
  );
  assert((await fs.stat(workspace)).isDirectory(), "released pending workspace was not created");
  console.log("OpenClaw released pending recovery passed");
}

async function main() {
  const spec = await readFirstRunSpec();
  const tempState = await createE2eStateDir("openclaw-system-agent-first-run-");
  tempState.registerExitCleanup();
  const stateDir = tempState.stateDir;
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  // Keep mutable logs/config outside the hashed package tree. Every file below
  // this root is part of the durable CLI owner checked before persistent setup.
  const fakeBinDir = path.join(stateDir, "fake-claude-package", "bin");
  const promptLogPath = path.join(stateDir, "fake-claude-prompts.jsonl");
  setEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setEnvValue("PATH", `${fakeBinDir}:${process.env.PATH ?? ""}`);
  Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });

  clearConfigCache();
  assert(
    await shouldStartOnboardingForFreshInstall(["node", "openclaw"]),
    "fresh bare OpenClaw invocation did not route to onboarding",
  );

  const blocked = await runPackagedCli(["setup", "--message", "overview"]);
  assert(blocked.code === 1, "OpenClaw did not fail closed without inference");
  assert(
    `${blocked.stdout}\n${blocked.stderr}`.includes("openclaw onboard"),
    "blocked OpenClaw did not direct the user to inference onboarding",
  );

  const plannerCommand = `setup workspace ${spec.dockerDefaultWorkspace}`;
  await installFakeClaudeCli(fakeBinDir, promptLogPath, plannerCommand);
  const activationRuntime = createRuntime();
  const guided: {
    activation?: Awaited<ReturnType<typeof activateSetupInference>>;
    interruptions: number;
    handoffs: number;
    choices: string[];
    runId?: string;
  } = { interruptions: 0, handoffs: 0, choices: [] };
  // Let guided onboarding own consent and the SQLite receipt, then interrupt
  // its existing apply boundary before workspace setup.
  await runGuidedOnboarding({ workspace: spec.dockerDefaultWorkspace }, activationRuntime.runtime, {
    createPrompter: () => ({
      intro: async () => {},
      outro: async () => {},
      note: async (message) => {
        activationRuntime.lines.push(message);
      },
      select: async ({ options }) => {
        const choice = options.find(({ value }) =>
          ["quick", "one", "detected-ai", "candidate:claude-cli"].includes(String(value)),
        );
        assert(choice, "guided onboarding offered an unexpected selection");
        const value = String(choice.value);
        assert(!guided.choices.includes(value), `guided onboarding repeated ${value}`);
        guided.choices.push(value);
        return choice.value;
      },
      multiselect: async () => {
        throw new Error("guided onboarding requested an unexpected multiselect");
      },
      text: async () => {
        throw new Error("guided onboarding requested unexpected text");
      },
      confirm: async () => {
        throw new Error("guided onboarding requested an unexpected confirmation");
      },
      progress: () => ({ update: () => {}, stop: () => {} }),
    }),
    activate: async (params) => {
      assert(!guided.activation, "guided onboarding repeated inference activation");
      assert(params.kind === "claude-cli", "guided onboarding selected a different runtime");
      // Forward the producer's commit callback unchanged; it claims the receipt.
      guided.activation = await activateSetupInference(params);
      return guided.activation;
    },
    applySetup: async (params, hooks) => {
      assert(guided.interruptions === 0, "guided onboarding repeated setup apply");
      assert(
        params.workspace === spec.dockerDefaultWorkspace &&
          params.allowWorkspaceChange === true &&
          typeof params.assertCommitPreconditions === "function",
        "guided onboarding did not authorize its pending workspace",
      );
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      const owner = readLocalOnboardingStateForConfig(configPath, config);
      assert(
        owner?.status === "pending" &&
          owner.workspace === spec.dockerDefaultWorkspace &&
          owner.teamCoordinatorId === undefined &&
          owner.securityAcknowledgedAt === config.wizard?.securityAcknowledgedAt,
        "guided onboarding reached setup without its ordinary pending owner",
      );
      params.assertCommitPreconditions(config);
      hooks?.beforePersistentApply?.();
      guided.runId = owner.runId;
      guided.interruptions += 1;
      throw new Error(GUIDED_SETUP_INTERRUPTION);
    },
    runSystemAgentChat: async (workspace, runtime, acceptRisk, agentName) => {
      assert(
        guided.interruptions === 1 &&
          workspace === spec.dockerDefaultWorkspace &&
          runtime === activationRuntime.runtime &&
          acceptRisk &&
          agentName === "main",
        "guided onboarding did not hand its interrupted setup to recovery chat",
      );
      guided.handoffs += 1;
    },
  });
  assert(
    guided.interruptions === 1 &&
      guided.handoffs === 1 &&
      guided.choices[0] === "quick" &&
      guided.choices[1] === "one" &&
      guided.choices[2] === "detected-ai" &&
      activationRuntime.lines.filter((line) => line.includes(GUIDED_SETUP_INTERRUPTION)).length ===
        1,
    "guided onboarding did not reach the identified pre-apply interruption",
  );
  const activation = guided.activation;
  assert(activation, "guided onboarding did not activate inference");
  assert(activation.ok, `fake Claude inference activation failed: ${JSON.stringify(activation)}`);
  assert(
    activation.modelRef === EXPECTED_PERSISTED_MODEL,
    `activation selected the wrong model: ${activation.modelRef}`,
  );
  const inferenceConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const pendingOwner = readLocalOnboardingStateForConfig(configPath, inferenceConfig);
  assert(
    pendingOwner?.status === "pending" &&
      pendingOwner.runId === guided.runId &&
      pendingOwner.workspace === spec.dockerDefaultWorkspace &&
      pendingOwner.teamCoordinatorId === undefined &&
      pendingOwner.securityAcknowledgedAt === inferenceConfig.wizard?.securityAcknowledgedAt &&
      inferenceConfig.wizard?.accessMode === "full",
    "guided onboarding did not persist its ordinary pending owner and consent",
  );
  // The CLI probe route persists as a canonical model with a separate runtime pin.
  const persistedModel = resolveDefaultModel(inferenceConfig);
  assert(
    persistedModel === EXPECTED_PERSISTED_MODEL,
    `activation persisted model ${persistedModel}; expected ${EXPECTED_PERSISTED_MODEL}`,
  );
  const persistedRuntime =
    inferenceConfig.agents?.defaults?.models?.[EXPECTED_PERSISTED_MODEL]?.agentRuntime?.id;
  assert(
    persistedRuntime === "claude-cli",
    `activation pinned ${EXPECTED_PERSISTED_MODEL} to runtime ${persistedRuntime}; expected claude-cli`,
  );
  assert(
    inferenceConfig.agents?.defaults?.workspace === undefined &&
      inferenceConfig.gateway === undefined,
    "inference activation configured the rest before OpenClaw started",
  );
  const activationPrompts = await fs.readFile(promptLogPath, "utf8");
  assert(
    activationPrompts.includes(INFERENCE_PROBE_PROMPT),
    "inference activation did not send the live model probe",
  );

  const modern = await runPackagedCli([
    "onboard",
    "--modern",
    "--non-interactive",
    "--accept-risk",
    "--json",
  ]);
  assert(
    modern.code === 0,
    "modern compatibility entrypoint did not expose OpenClaw after activation",
  );
  const modernOverview = JSON.parse(modern.stdout) as { defaultModel?: string };
  assert(
    modernOverview.defaultModel === EXPECTED_PERSISTED_MODEL,
    `modern entrypoint exposed model ${modernOverview.defaultModel}; expected ${EXPECTED_PERSISTED_MODEL}`,
  );

  // An unrelated ambient channel credential must not alter the requested setup.
  setEnvValue(spec.telegramEnv, spec.telegramToken);
  setEnvValue(DISCORD_CREDENTIAL_ENV, DISCORD_CREDENTIAL_FIXTURE);

  const commandVars = {
    defaultWorkspace: spec.dockerDefaultWorkspace,
    agentWorkspace: spec.dockerAgentWorkspace,
    agentId: spec.agentId,
    model: spec.model,
    discordEnv: DISCORD_CREDENTIAL_ENV,
  };
  for (const command of spec.commands) {
    const message = renderCommandTemplate(command.message, commandVars);
    const probesBefore = countInferencePrompts(await readFakeClaudePromptLines(promptLogPath));
    const result = command.planner
      ? await runPackagedCli(["setup", "--message", message, ...(command.approve ? ["--yes"] : [])])
      : await runPackagedOneShot(message, command.approve);
    const output = `${result.stdout}\n${result.stderr}`;
    assert(
      result.code === 0 && output.includes(command.expectOutput),
      `OpenClaw first-run command ${command.id} did not apply: ${output}`,
    );
    if (command.id === "setup") {
      assert(result.code === 0, `OpenClaw setup exited with ${result.code}: ${output}`);
      assert(
        output.includes("[openclaw] done: openclaw.setup"),
        `OpenClaw setup did not report completion: ${output}`,
      );
      assert(
        output.includes(
          "Gateway: OpenClaw gateway lifecycle is managed by an external supervisor " +
            "(OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to start the gateway.",
        ),
        `OpenClaw setup did not report the externally supervised gateway: ${output}`,
      );
      assert(
        !output.includes("Systemd user services are not available"),
        `OpenClaw setup probed systemd before honoring external supervision: ${output}`,
      );
      assert(
        !output.includes("Gateway service install failed"),
        `OpenClaw setup attempted and failed gateway service installation: ${output}`,
      );
      assert(
        !output.includes("service management skipped: non-default state dir or config path"),
        `OpenClaw setup used the non-default-path service-management skip: ${output}`,
      );
      const setupConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      const completedOwner = readLocalOnboardingStateForConfig(configPath, setupConfig);
      assert(
        completedOwner?.status === "completed" &&
          completedOwner.runId === pendingOwner.runId &&
          completedOwner.workspace === pendingOwner.workspace &&
          completedOwner.securityAcknowledgedAt === pendingOwner.securityAcknowledgedAt &&
          setupConfig.agents?.defaults?.workspace === pendingOwner.workspace,
        "OpenClaw setup did not complete the same pending owner at its approved workspace",
      );
    }
    if (command.planner) {
      assert(
        output.includes(`[openclaw] planner: ${EXPECTED_PERSISTED_MODEL}`) &&
          output.includes(FAKE_PLANNER_REPLY) &&
          output.includes(`[openclaw] interpreted: ${plannerCommand}`),
        `OpenClaw first-run command ${command.id} did not use the verified planner: ${output}`,
      );
    }
    const probesAfter = countInferencePrompts(await readFakeClaudePromptLines(promptLogPath));
    const probeDelta = probesAfter - probesBefore;
    const minimumProbes = command.approve ? 2 : 1;
    assert(
      probeDelta >= minimumProbes,
      `OpenClaw command ${command.id} ran ${probeDelta} inference probes; expected at least ${minimumProbes} for preflight${command.approve ? " plus its persistent boundary" : ""}`,
    );
    console.log(`OpenClaw first-run command ${command.id} passed`);
  }

  const probeLines = await readFakeClaudePromptLines(promptLogPath);
  const inferencePrompts = probeLines.filter((line) => line.includes(INFERENCE_PROBE_PROMPT));
  const plannerPrompts = probeLines.filter((line) => line.includes("User request:"));
  const minimumEntryAndActivationProbes = spec.commands.length + 1;
  const minimumPersistentBoundaryProbes = spec.auditOperations.length;
  assert(
    inferencePrompts.length >= minimumEntryAndActivationProbes + minimumPersistentBoundaryProbes,
    `expected activation/preflight probes plus at least ${minimumPersistentBoundaryProbes} persistent-boundary probes; got ${inferencePrompts.length}`,
  );
  assert(
    plannerPrompts.length === 1 && plannerPrompts[0]?.includes("finish basic setup"),
    `expected one fuzzy setup planner prompt; got ${plannerPrompts.length}`,
  );
  assert(
    probeLines.length === inferencePrompts.length + plannerPrompts.length,
    `unexpected fake Claude prompt count: ${probeLines.length}`,
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === spec.dockerDefaultWorkspace,
    "first-run setup did not write default workspace",
  );
  assert(resolveDefaultModel(config) === spec.model, "first-run setup did not write default model");
  const reef = config.agents?.entries?.[spec.agentId];
  assert(reef, "OpenClaw did not create reef agent");
  assert(reef.workspace === spec.dockerAgentWorkspace, "OpenClaw did not write reef workspace");
  assert(
    reef.model === undefined,
    "OpenClaw wrote a per-agent model instead of inheriting the verified default",
  );
  assert(config.channels?.discord?.enabled === true, "OpenClaw did not enable Discord");
  const discordToken = config.channels?.discord?.token;
  assert(
    discordToken &&
      typeof discordToken === "object" &&
      "source" in discordToken &&
      discordToken.source === "env" &&
      "id" in discordToken &&
      discordToken.id === DISCORD_CREDENTIAL_ENV,
    "OpenClaw did not write Discord token SecretRef",
  );
  assert(
    !JSON.stringify(config.channels.discord).includes(DISCORD_CREDENTIAL_FIXTURE),
    "OpenClaw persisted the raw Discord token",
  );
  assert(config.channels?.telegram === undefined, "ambient Telegram credentials altered config");
  assert(
    !JSON.stringify(config).includes(spec.telegramToken),
    "OpenClaw persisted an unrelated ambient credential",
  );

  const audit = createSqliteAuditRecordStore<SystemAgentAuditEntry>({
    scope: SYSTEM_AGENT_AUDIT_SCOPE,
    maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  }).entries();
  for (const operation of spec.auditOperations) {
    assert(
      audit.some((entry) => entry.value.operation === operation),
      `${operation} audit entry missing`,
    );
  }

  console.log("OpenClaw fresh guided first-run baseline passed");
  await runReleasedPendingRecovery(inferenceConfig);
  console.log("OpenClaw first-run Docker E2E passed");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
