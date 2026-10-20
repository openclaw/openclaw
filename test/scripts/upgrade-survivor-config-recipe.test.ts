import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  resolveScenarioConfigSteps,
  resolveUpgradeSurvivorConfigSteps as recipeSteps,
  resolveUpgradeSurvivorConfigStepsForBaseline as baselineSteps,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { buildInlineProviderModels } from "../../src/agents/embedded-agent-runner/model.inline-provider.js";
import { ModelsConfigSchema } from "../../src/config/zod-schema.core.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const expectSuccess = (result: ReturnType<typeof spawnSync>) =>
  expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
const stepIds = (steps: { id: string }[]) => steps.map((step) => step.id);
const configValue = (steps: ReturnType<typeof recipeSteps>, id: string) =>
  JSON.parse(steps.find((step) => step.id === id)?.argv[3] ?? "{}");
const provider = (api: string, id: string, baseUrl: string, models: unknown[] = []) => ({
  api,
  apiKey: { source: "env", provider: "default", id },
  baseUrl,
  models,
});

const RECIPE_PATH = "scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
const RUN_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";
const DOCKER_RUNNER_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const sharedSteps = [
  ["update-channel", "update"],
  ["gateway", "gateway"],
  ["models-openai", "models"],
  ["models-anthropic", "models-anthropic"],
  ["models-google", "models-google"],
  ["agents", "agents"],
  ["skills", "skills"],
  ["plugins", "plugins"],
];
const sharedIds = sharedSteps.map(([id]) => id);
const sharedIntents = sharedSteps.map(([, intent]) => intent);

function configLeafWrites(steps: ReturnType<typeof recipeSteps>) {
  return steps.flatMap((step): { path: string; value: unknown }[] => {
    if (step.argv[0] !== "config" || step.argv[1] !== "set") {
      return [];
    }
    if (step.argv[2] === "--batch-json") {
      return JSON.parse(step.argv[3] ?? "[]");
    }
    return step.argv[4] === "--strict-json"
      ? [{ path: step.argv[2] ?? "", value: JSON.parse(step.argv[3] ?? "null") }]
      : [];
  });
}

function runRecipeFixture(params: { version: string; scenario: string; failPath?: string }) {
  const root = tempDirs.make("openclaw-upgrade-recipe-");
  const binDir = join(root, "bin");
  const logPath = join(root, "openclaw-argv.jsonl");
  const summaryPath = join(root, "summary.json");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "openclaw-log.js"),
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const failPath = process.env.RECIPE_FAIL_PATH;
const failed = failPath && args[0] === "config" && args[1] === "set" &&
  (args[2] === failPath || (args[2] === "--batch-json" &&
    JSON.parse(args[3]).some((entry) => entry.path === failPath)));
process.exit(failed ? 17 : 0);
`,
  );
  writeFileSync(join(binDir, "openclaw"), `#!/usr/bin/env node\nrequire("./openclaw-log.js");\n`);
  chmodSync(join(binDir, "openclaw"), 0o755);
  writeFileSync(
    join(binDir, "openclaw.cmd"),
    `@echo off\r\n"${process.execPath}" "%~dp0openclaw-log.js" %*\r\n`,
  );
  const args = [
    "--import",
    "tsx",
    RECIPE_PATH,
    "apply",
    "--summary",
    summaryPath,
    "--baseline-version",
    params.version,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_STATE_DIR: join(root, "state"),
      OPENCLAW_CONFIG_PATH: join(root, "config.json"),
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: params.scenario,
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL: "",
      RECIPE_FAIL_PATH: params.failPath ?? "",
      PATH: [binDir, join(process.cwd(), "node_modules/.bin"), process.env.PATH ?? ""].join(
        delimiter,
      ),
    },
  });
  const loggedArgs: string[][] = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    result,
    loggedArgs,
    summary: existsSync(summaryPath) ? readJson(summaryPath) : null,
  };
}

describe("upgrade survivor config recipe command resolution", () => {
  it("selects the prerelease update channel for the plugin registry", () => {
    const runner = readFileSync(RUN_PATH, "utf8");
    expect(runner).toContain('OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="beta"');
    expect(runner).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION");
  });

  it.skipIf(process.platform === "win32").each([
    { liveEnv: {}, expectedKeys: [] },
    {
      liveEnv: {
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: "google/gemini-3.1-pro-preview",
      },
      expectedKeys: ["GEMINI_API_KEY"],
    },
  ])(
    "launches the published baseline with trusted sources and only selected keys: $expectedKeys",
    ({ liveEnv, expectedKeys }) => {
      const root = realpathSync(tempDirs.make("openclaw-upgrade-docker-boundary-"));
      const harnessRoot = realpathSync(process.cwd());
      const candidateRoot = join(root, "candidate");
      const binDir = join(root, "bin");
      const candidate = join(candidateRoot, "candidate.tgz");
      const stateScript = "scripts/lib/openclaw-test-state.mts";
      mkdirSync(join(candidateRoot, dirname(stateScript)), { recursive: true });
      cpSync(stateScript, join(candidateRoot, stateScript));
      writeFileSync(candidate, "unused by the Docker boundary stub");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "docker"),
        `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  image) test "$2" = inspect ;;
  run) printf '%s\\0' "$@" >"$TMPDIR/docker-args" ;;
  *) echo "Unexpected Docker command: $1" >&2; exit 1 ;;
esac
`,
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [join(harnessRoot, DOCKER_RUNNER_PATH)], {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: root,
          TMPDIR: root,
          PATH: [binDir, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_DOCKER_E2E_REPO_ROOT: candidateRoot,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: join(root, "artifacts"),
          OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
          OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE: candidate,
          OPENAI_API_KEY: "fixture-openai-key",
          ANTHROPIC_API_KEY: "fixture-anthropic-key",
          GEMINI_API_KEY: "fixture-google-key",
          ...liveEnv,
        },
      });
      expectSuccess(result);
      const args = readFileSync(join(root, "docker-args"), "utf8").split("\0").slice(0, -1);
      const envArgs = args.filter((_, index) => args[index - 1] === "-e");
      expect(
        envArgs.filter((arg) =>
          ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"].includes(arg),
        ),
      ).toEqual(expectedKeys);
      expect(args.join(" ")).not.toMatch(/fixture-(openai|anthropic|google)-key/u);
      const mounts = args.filter((_, index) => args[index - 1] === "-v");
      expect(mounts.filter((mount) => mount.includes("node_modules"))).toEqual([]);
      expect(args).toContain(
        "OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT=/usr/local/lib/node_modules/tsx/dist/loader.mjs",
      );
      expect(mounts).toEqual(
        expect.arrayContaining([
          `${harnessRoot}/scripts/e2e:/app/scripts/e2e:ro`,
          `${harnessRoot}/scripts/lib:/app/scripts/lib:ro`,
          `${harnessRoot}/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro`,
          `${harnessRoot}/${RUN_PATH}:/tmp/openclaw-upgrade-survivor-run.sh:ro`,
          `${candidate}:/tmp/openclaw-current.tgz:ro`,
        ]),
      );
      expect(mounts.filter((mount) => mount.startsWith(`${candidateRoot}/`))).toEqual([
        `${candidate}:/tmp/openclaw-current.tgz:ro`,
      ]);
      expect(args).toContain("OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC=/tmp/openclaw-current.tgz");
      expect(args.slice(-5)).toEqual([
        "timeout",
        "--kill-after=30s",
        "1200s",
        "bash",
        "/tmp/openclaw-upgrade-survivor-run.sh",
      ]);
    },
  );

  it("wraps Windows openclaw npm shims through cmd.exe", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(
        ["config", "set", "models.providers.openai", '{"apiKey":"sk test"}', "--strict-json"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        'openclaw.cmd config set models.providers.openai "{""apiKey"":""sk test""}" --strict-json',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      commandLabel:
        'openclaw config set models.providers.openai {"apiKey":"sk test"} --strict-json',
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps every recipe file in the prepared test layout", () => {
    // Prepared tooling workers copy only listed assets, but the recipe reads any section file by name.
    const buildEntries = readFileSync("scripts/lib/vitest-worker-build-entries.mts", "utf8");
    const recipeDirectory = "scripts/e2e/lib/upgrade-survivor/config-recipe";
    const missing = readdirSync(recipeDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${recipeDirectory}/${name}`)
      .filter((file) => !buildEntries.includes(JSON.stringify(file)));
    expect(missing).toEqual([]);
  });

  it("keeps the prerelease plugin registry on the beta update channel", () => {
    const updateChannels = recipeSteps("prerelease-plugin-registry")
      .filter((step) => step.argv.slice(0, 3).join(" ") === "config set update.channel")
      .map((step) => step.argv[3]);

    expect(updateChannels.at(-1)).toBe("beta");
  });

  it("enables private integrity file logging only for the base recipe before validation", () => {
    const { result, loggedArgs, summary } = runRecipeFixture({
      scenario: "base",
      version: "2026.9.4",
    });
    expectSuccess(result);
    expect(summary.acceptedIntents).toContain("logging");
    const root = tempDirs.make("openclaw-upgrade-logging-");
    const config = join(root, "config.json");
    const coverage = join(root, "coverage.json");
    writeJson(config, {
      logging: Object.fromEntries(
        loggedArgs.flatMap((args) =>
          args[2]?.startsWith("logging.") ? [[args[2].slice("logging.".length), args[3]]] : [],
        ),
      ),
    });
    writeJson(coverage, {
      acceptedIntents: summary.acceptedIntents.filter((intent: string) => intent === "logging"),
    });
    const assertions = ["baseline", "survival"].map((stage) =>
      spawnSync(
        process.execPath,
        ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", "assert-config"],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            OPENCLAW_STATE_DIR: join(root, "state"),
            OPENCLAW_CONFIG_PATH: config,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
            OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coverage,
            OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage,
          },
        },
      ),
    );
    expect(
      assertions.map((assertion) => assertion.status),
      assertions.map((assertion) => assertion.stdout + assertion.stderr).join("\n"),
    ).toEqual([0, 0]);
    expect(loggedArgs.slice(-3)).toEqual([
      ["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"],
      ["config", "set", "logging.level", "debug"],
      ["config", "validate"],
    ]);
    expect(loggedArgs.some((args) => args[2]?.startsWith("logging.console"))).toBe(false);
    expect(
      recipeSteps("tilde-log-path")
        .filter((step) => step.intent === "logging")
        .map((step) => step.argv),
    ).toEqual([["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"]]);
    expect(recipeSteps("feishu-channel").some((step) => step.intent === "logging")).toBe(false);
  });

  it("authors schema-valid provider credentials without changing the primary model", () => {
    const steps = baselineSteps("base", null);
    const writes = configLeafWrites(steps);
    const providers = Object.fromEntries(
      writes
        .filter((entry) => entry.path.startsWith("models.providers."))
        .map((entry) => [entry.path.slice("models.providers.".length), entry.value]),
    );
    const gemini = {
      id: "gemini-3.1-pro-preview",
      reasoning: true,
      contextWindow: 1048576,
      maxTokens: 65536,
    };
    const googleProvider = provider(
      "google-generative-ai",
      "GEMINI_API_KEY",
      "https://generativelanguage.googleapis.com/v1beta",
      [
        {
          ...gemini,
          name: "Gemini 3.1 Pro Preview",
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    );
    expect(ModelsConfigSchema.safeParse({ providers }).success).toBe(true);
    expect(providers).toEqual({
      openai: provider("openai-responses", "OPENAI_API_KEY", "https://api.openai.com/v1"),
      anthropic: provider("anthropic-messages", "ANTHROPIC_API_KEY", "https://api.anthropic.com"),
      google: googleProvider,
    });
    expect(writes.find((entry) => entry.path === "agents")?.value).toMatchObject({
      defaults: { model: { primary: "openai/gpt-5.5" } },
    });
    const google = configValue(steps, "models-google");
    expect(buildInlineProviderModels({ google })).toEqual([
      expect.objectContaining({
        ...gemini,
        provider: "google",
        api: googleProvider.api,
        baseUrl: googleProvider.baseUrl,
      }),
    ]);
  });

  it("keeps all configured provider owners allowed in the base recipe", () => {
    for (const version of ["2026.6.1", "2026.8.1", "2026.9.5"]) {
      let allow: string[] = [];
      for (const step of baselineSteps("base", version)) {
        if (step.argv[2] === "plugins") {
          allow = JSON.parse(step.argv[3] ?? "{}").allow;
        } else if (step.argv[2] === "plugins.allow") {
          allow = JSON.parse(step.argv[3] ?? "[]");
        }
      }
      expect(allow).toEqual(expect.arrayContaining(["anthropic", "google", "openai"]));
    }
  });

  it("uses password auth for mobile pairing reconnect coverage", () => {
    const steps = baselineSteps("mobile-pairing-reconnect", "2026.6.34");
    const gateway = configValue(steps, "gateway");

    expect(steps.map((step) => step.intent)).toEqual(["update", "gateway", "validate"]);
    expect(gateway.auth).toEqual({
      mode: "password",
      password: {
        source: "env",
        provider: "default",
        id: "GATEWAY_AUTH_PASSWORD_REF",
      },
    });
    expect(gateway.auth).not.toHaveProperty("token");
  });

  it("composes configured plugin installs into the SQLite volume scenario", () => {
    expect(resolveScenarioConfigSteps("sqlite-volume")).toEqual(
      resolveScenarioConfigSteps("configured-plugin-installs"),
    );
  });

  it.each(["2026.7.1-2", "2026.7.2-beta.3"])(
    "authors one version-correct recovery roster for %s",
    (version) => {
      const steps = baselineSteps("recovery-cleanup", version);
      const agentSteps = steps.filter(
        (step) =>
          step.argv[0] === "config" && step.argv[1] === "set" && step.argv[2]?.startsWith("agents"),
      );
      expect(agentSteps).toHaveLength(1);
      expect(agentSteps[0]?.argv.slice(0, 3)).toEqual(["config", "set", "agents"]);
      const agents = configValue(steps, "agents");
      expect(agents.list.map((agent: { id: string }) => agent.id)).toEqual([
        "main",
        "ops",
        "recovery-clean",
        "recovery-protected",
      ]);
      expect([agents.entries, agents.ownership, agents.defaults.heartbeat.every]).toEqual([
        undefined,
        undefined,
        "0m",
      ]);
      expect(agents.list.find((agent: { id: string }) => agent.id === "ops")).toMatchObject({
        fastModeDefault: true,
      });
      expect(agents.list.filter((entry: { default?: boolean }) => entry.default)).toEqual([
        expect.objectContaining({ id: "main", default: true }),
      ]);
      const baseAgents = configValue(baselineSteps("base", version), "agents");
      expect(baseAgents.list.map((agent: { id: string }) => agent.id)).toEqual(["main", "ops"]);
      expect(configLeafWrites(steps)).toContainEqual({
        path: "channels.whatsapp",
        value: readJson("scripts/e2e/lib/upgrade-survivor/config-recipe/channels-whatsapp.json"),
      });
      expect(steps.at(-1)?.id).toBe("validate");
    },
  );

  it("authors Tool Search through the baseline CLI", () => {
    const version = "2026.9.7";
    const { result, summary, loggedArgs } = runRecipeFixture({ scenario: "base", version });
    expectSuccess(result);
    expect(summary.baselineVersion).toBe(version);
    expect(summary.acceptedIntents).toContain("tool-search");
    expect(loggedArgs).toContainEqual([
      "config",
      "set",
      "tools.toolSearch",
      JSON.stringify({ mode: "tools" }),
      "--strict-json",
    ]);
    expect(loggedArgs.at(-1)).toEqual(["config", "validate"]);
  });

  it("bounds baseline config commands and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const outcome = runUpgradeSurvivorOpenClawStep(
      { argv: ["config", "validate"], id: "validate", intent: "validate" },
      {
        spawnSyncCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          return {
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: "still validating",
            stdout: "partial output",
          };
        },
      },
    );

    expect(calls).toMatchObject([
      {
        args: ["config", "validate"],
        command: "openclaw",
        options: {
          killSignal: "SIGTERM",
          maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
          timeout: CONFIG_COMMAND_TIMEOUT_MS,
        },
      },
    ]);
    expect(outcome).toMatchObject({
      command: "openclaw config validate",
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync openclaw ETIMEDOUT",
      ok: false,
      signal: "SIGTERM",
      status: null,
      stderr: "still validating",
      stdout: "partial output",
    });
  });

  it("records one successful batch before overrides and final validation", () => {
    const scenario = "configured-plugin-installs";
    const version = "2026.6.34";
    const { result, summary, loggedArgs } = runRecipeFixture({ scenario, version });
    expectSuccess(result);
    const steps = baselineSteps(scenario, version);
    expect(loggedArgs).toEqual(steps.map((step) => step.argv));
    expect(stepIds(summary.steps)).toEqual([
      ...sharedIds,
      "channels",
      "tools-tool-search",
      "plugins-configured-installs",
      "channels-whatsapp-unset",
      "channels-matrix",
      "validate",
    ]);
    expect(summary.steps.find((step: { id: string }) => step.id === "channels")).toMatchObject({
      id: "channels",
      ok: true,
      status: 0,
      intents: ["discord-channel", "telegram-channel", "whatsapp-channel"],
    });
    expect(summary.acceptedIntents).toEqual([
      ...sharedIntents,
      "discord-channel",
      "telegram-channel",
      "whatsapp-channel",
      "tool-search",
      "configured-plugin-installs",
      "validate",
    ]);
  });

  it.each([
    { version: "2026.6.34", batched: true },
    { version: "2026.6.1", batched: false },
  ])(
    "preserves failure receipts and aborts without fallback for $version",
    ({ version, batched }) => {
      const { result, summary, loggedArgs } = runRecipeFixture({
        scenario: "configured-plugin-installs",
        version,
        failPath: "channels.telegram",
      });
      expect(result.status).toBe(1);
      expect(stepIds(summary.steps)).toEqual([
        ...sharedIds,
        ...(batched ? ["channels"] : ["channels-discord", "channels-telegram"]),
      ]);
      expect(summary.steps.slice(0, -1).every((step: { ok: boolean }) => step.ok)).toBe(true);
      expect(summary.steps.at(-1)).toMatchObject({
        id: batched ? "channels" : "channels-telegram",
        ok: false,
        status: 17,
      });
      expect(summary.acceptedIntents).toEqual([
        ...sharedIntents,
        ...(batched ? [] : ["discord-channel"]),
      ]);
      const steps = baselineSteps("configured-plugin-installs", version);
      expect(loggedArgs).toEqual(steps.slice(0, batched ? 9 : 10).map((step) => step.argv));
      expect(result.stderr).toContain(
        `baseline config recipe failed at ${batched ? "channels" : "channels-telegram"}: 17`,
      );
    },
  );
});
