// Crestodian first-run Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { shouldStartOnboardingForFreshInstall } from "../../../../dist/cli/run-main.js";
import { clearConfigCache } from "../../../../dist/config/config.js";
import type { OpenClawConfig } from "../../../../dist/config/types.openclaw.js";
import { activateSetupInference } from "../../../../dist/crestodian/setup-inference.js";
import type { RuntimeEnv } from "../../../../dist/runtime.js";
import { createE2eStateDir } from "../../../../scripts/e2e/lib/temp-state-dir.ts";

type CrestodianFirstRunCommand = {
  id: string;
  message: string;
  expectOutput: string;
  approve: boolean;
};

type CrestodianFirstRunSpec = {
  dockerDefaultWorkspace: string;
  dockerAgentWorkspace: string;
  agentId: string;
  model: string;
  discordEnv: string;
  discordToken: string;
  commands: CrestodianFirstRunCommand[];
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

async function readFirstRunSpec(): Promise<CrestodianFirstRunSpec> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "scripts", "e2e", "crestodian-first-run-spec.json"),
      "utf8",
    ),
  ) as CrestodianFirstRunSpec;
}

function renderCommandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => vars[key] ?? match);
}

async function installFakeClaudeCli(fakeBinDir: string, promptLogPath: string): Promise<void> {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const scriptPath = path.join(fakeBinDir, "claude");
  await fs.writeFile(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "claude 99.0.0"',
      "  exit 0",
      "fi",
      "IFS= read -r prompt_line || true",
      `printf '%s\\n' "$prompt_line" >> ${JSON.stringify(promptLogPath)}`,
      'node -e \'console.log(JSON.stringify({ type: "result", session_id: "fake-claude-session", result: "OK", usage: { input_tokens: 1, output_tokens: 1 } }))\'',
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(scriptPath, 0o755);
}

async function runPackagedCli(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
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
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function main() {
  const spec = await readFirstRunSpec();
  const tempState = await createE2eStateDir("openclaw-crestodian-first-run-");
  tempState.registerExitCleanup();
  const stateDir = tempState.stateDir;
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  const fakeBinDir = path.join(stateDir, "fake-bin");
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

  const blocked = await runPackagedCli(["crestodian", "--message", "overview"]);
  assert(blocked.code === 1, "Crestodian did not fail closed without inference");
  assert(
    `${blocked.stdout}\n${blocked.stderr}`.includes("openclaw onboard"),
    "blocked Crestodian did not direct the user to inference onboarding",
  );
  const blockedModern = await runPackagedCli([
    "onboard",
    "--modern",
    "--non-interactive",
    "--json",
  ]);
  assert(
    blockedModern.code === 1 &&
      `${blockedModern.stdout}\n${blockedModern.stderr}`.includes('"ok": false'),
    "modern compatibility entrypoint did not fail closed with structured JSON",
  );

  await installFakeClaudeCli(fakeBinDir, promptLogPath);
  const activationRuntime = createRuntime();
  const activation = await activateSetupInference({
    kind: "claude-cli",
    workspace: spec.dockerDefaultWorkspace,
    surface: "cli",
    runtime: activationRuntime.runtime,
  });
  assert(activation.ok, `fake Claude inference activation failed: ${JSON.stringify(activation)}`);
  assert(
    activation.modelRef === "claude-cli/claude-opus-4-8",
    `activation selected the wrong model: ${activation.modelRef}`,
  );
  const inferenceConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const persistedInferenceModel =
    typeof inferenceConfig.agents?.defaults?.model === "string"
      ? inferenceConfig.agents.defaults.model
      : inferenceConfig.agents?.defaults?.model?.primary;
  assert(
    persistedInferenceModel === activation.modelRef,
    "activation did not persist the verified inference route",
  );
  assert(
    inferenceConfig.agents?.defaults?.workspace === undefined &&
      inferenceConfig.gateway === undefined,
    "inference activation configured the rest before Crestodian started",
  );
  const activationPrompts = await fs.readFile(promptLogPath, "utf8");
  assert(
    activationPrompts.includes("Reply with the single word OK"),
    "inference activation did not send the live model probe",
  );

  const modern = await runPackagedCli(["onboard", "--modern", "--non-interactive", "--json"]);
  assert(
    modern.code === 0 && `${modern.stdout}\n${modern.stderr}`.includes(activation.modelRef),
    "modern compatibility entrypoint did not open Crestodian after activation",
  );

  const overview = await runPackagedCli(["crestodian", "--message", "overview"]);
  const overviewOutput = `${overview.stdout}\n${overview.stderr}`;
  assert(overview.code === 0, `verified Crestodian CLI failed: ${overviewOutput}`);
  assert(
    overviewOutput.includes("claude-cli/claude-opus-4-8"),
    "verified overview did not report the activated model",
  );

  setEnvValue(spec.discordEnv, spec.discordToken);

  const commandVars = {
    defaultWorkspace: spec.dockerDefaultWorkspace,
    agentWorkspace: spec.dockerAgentWorkspace,
    agentId: spec.agentId,
    model: spec.model,
    discordEnv: spec.discordEnv,
  };
  for (const command of spec.commands) {
    const message = renderCommandTemplate(command.message, commandVars);
    const result = await runPackagedCli([
      "crestodian",
      "--message",
      message,
      ...(command.approve ? ["--yes"] : []),
    ]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert(
      result.code === 0 && output.includes(command.expectOutput),
      `Crestodian first-run command ${command.id} did not apply: ${output}`,
    );
  }

  const probeLines = (await fs.readFile(promptLogPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert(
    probeLines.length === spec.commands.length + 3,
    `expected one live probe per Crestodian CLI call; got ${probeLines.length}`,
  );

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  assert(
    config.agents?.defaults?.workspace === spec.dockerDefaultWorkspace,
    "first-run setup did not write default workspace",
  );
  assert(
    config.agents?.defaults?.model &&
      typeof config.agents.defaults.model === "object" &&
      "primary" in config.agents.defaults.model &&
      config.agents.defaults.model.primary === spec.model,
    "first-run setup did not write default model",
  );
  const reef = config.agents?.list?.find((agent) => agent.id === spec.agentId);
  assert(reef, "Crestodian did not create reef agent");
  assert(reef.workspace === spec.dockerAgentWorkspace, "Crestodian did not write reef workspace");
  assert(reef.model === spec.model, "Crestodian did not write reef model");
  assert(config.plugins?.allow?.includes("discord"), "Crestodian did not allow Discord plugin");
  assert(
    config.plugins?.entries?.discord?.enabled === true,
    "Crestodian did not enable Discord plugin entry",
  );
  assert(config.channels?.discord?.enabled === true, "Crestodian did not enable Discord");
  const discordToken = config.channels?.discord?.token;
  assert(
    discordToken &&
      typeof discordToken === "object" &&
      "source" in discordToken &&
      discordToken.source === "env" &&
      "id" in discordToken &&
      discordToken.id === spec.discordEnv,
    "Crestodian did not write Discord token SecretRef",
  );
  assert(
    !JSON.stringify(config.channels.discord).includes(spec.discordToken),
    "Crestodian persisted the raw Discord token",
  );

  const auditPath = path.join(stateDir, "audit", "crestodian.jsonl");
  const audit = (await fs.readFile(auditPath, "utf8")).trim();
  for (const operation of spec.auditOperations) {
    assert(audit.includes(`"operation":"${operation}"`), `${operation} audit entry missing`);
  }

  console.log("Crestodian first-run Docker E2E passed");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
