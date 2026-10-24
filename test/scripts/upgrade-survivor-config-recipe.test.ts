import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  resolveScenarioConfigSteps,
  resolveUpgradeSurvivorConfigSteps as recipeSteps,
  resolveUpgradeSurvivorConfigStepsForBaseline as baselineSteps,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { ModelsConfigSchema } from "../../src/config/zod-schema.core.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readJson,
  readJsonLines,
  writeExecutable,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const expectSuccess = (result: ReturnType<typeof spawnSync>) =>
  expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
const configValue = (steps: ReturnType<typeof recipeSteps>, id: string) =>
  JSON.parse(steps.find((step) => step.id === id)?.argv[3] ?? "{}");

const RECIPE_PATH = "scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
const DOCKER_RUNNER_PATH = "scripts/e2e/upgrade-survivor-docker.sh";

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
  writeExecutable(join(binDir, "openclaw"), `#!/usr/bin/env node\nrequire("./openclaw-log.js");\n`);
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
  return {
    result,
    loggedArgs: existsSync(logPath) ? readJsonLines<string[]>(logPath) : [],
    summary: existsSync(summaryPath) ? readJson(summaryPath) : null,
  };
}

describe("upgrade survivor config recipe command resolution", () => {
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
      writeExecutable(
        join(binDir, "docker"),
        `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  image) test "$2" = inspect ;;
  run) printf '%s\\0' "$@" >"$TMPDIR/docker-args" ;;
  *) echo "Unexpected Docker command: $1" >&2; exit 1 ;;
esac
`,
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
      const trustedMounts = mounts.filter((mount) => mount.startsWith(`${harnessRoot}/`));
      expect(trustedMounts.length).toBeGreaterThan(0);
      expect(trustedMounts.every((mount) => mount.endsWith(":ro"))).toBe(true);
      expect(trustedMounts).toContain(
        `${harnessRoot}/scripts/e2e/lib/upgrade-survivor/run.sh:${args.at(-1)}:ro`,
      );
      expect(mounts.filter((mount) => mount.startsWith(`${candidateRoot}/`))).toEqual([
        `${candidate}:/tmp/openclaw-current.tgz:ro`,
      ]);
      expect(args).toContain("OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC=/tmp/openclaw-current.tgz");
    },
  );

  it("wraps Windows openclaw npm shims through cmd.exe", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(
        ["config", "set", "x", '{"apiKey":"sk test"}', "--strict-json"],
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
        'openclaw.cmd config set x "{""apiKey"":""sk test""}" --strict-json',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      commandLabel: 'openclaw config set x {"apiKey":"sk test"} --strict-json',
      shell: false,
      windowsVerbatimArguments: true,
    });
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
    expectSuccess(
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
            OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: "survival",
          },
        },
      ),
    );
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
    const providers = Object.fromEntries(
      steps
        .filter((step) => step.argv[2]?.startsWith("models.providers."))
        .map((step) => [
          step.argv[2]!.slice("models.providers.".length),
          configValue(steps, step.id),
        ]),
    );
    expect(ModelsConfigSchema.safeParse({ providers }).success).toBe(true);
    expect(providers).toMatchObject({
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
      anthropic: { apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" } },
      google: { apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" } },
    });
    expect(configValue(steps, "agents")).toMatchObject({
      defaults: { model: { primary: "openai/gpt-5.5" } },
    });
    expect(configValue(steps, "plugins").allow).toEqual(
      expect.arrayContaining(Object.keys(providers)),
    );
  });

  it("uses password auth for mobile pairing reconnect coverage", () => {
    const steps = baselineSteps("mobile-pairing-reconnect", "2026.6.34");
    const gateway = configValue(steps, "gateway");

    expect(steps.map((step) => step.intent)).toEqual(["update", "gateway", "validate"]);
    expect(gateway.auth).toEqual({
      mode: "password",
      password: { source: "env", provider: "default", id: "GATEWAY_AUTH_PASSWORD_REF" },
    });
  });

  it("composes configured plugin installs into the SQLite volume scenario", () => {
    expect(resolveScenarioConfigSteps("sqlite-volume")).toEqual(
      resolveScenarioConfigSteps("configured-plugin-installs"),
    );
  });

  it.each(["2026.7.1-2"])("authors one version-correct recovery roster for %s", (version) => {
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
    expect(steps.at(-1)?.id).toBe("validate");
  });

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
    const output = {
      signal: "SIGTERM",
      status: null,
      stderr: "still validating",
      stdout: "partial output",
    } as const;
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const spawnSyncCommand = vi.fn(() => ({ ...output, error: timeoutError }));
    const outcome = runUpgradeSurvivorOpenClawStep(
      { argv: ["config", "validate"], id: "validate", intent: "validate" },
      { spawnSyncCommand },
    );
    expect(spawnSyncCommand.mock.calls).toEqual([
      [
        "openclaw",
        ["config", "validate"],
        expect.objectContaining({
          killSignal: "SIGTERM",
          maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
          timeout: CONFIG_COMMAND_TIMEOUT_MS,
        }),
      ],
    ]);
    expect(outcome).toMatchObject({
      command: "openclaw config validate",
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync openclaw ETIMEDOUT",
      ok: false,
      ...output,
    });
  });

  it.each([
    { version: "2026.6.34", batched: true, failPath: undefined },
    { version: "2026.6.34", batched: true, failPath: "channels.telegram" },
    { version: "2026.6.1", batched: false, failPath: "channels.telegram" },
  ])(
    "records recipe receipts and stops at the first failure ($version, $failPath)",
    ({ version, batched, failPath }) => {
      const scenario = "configured-plugin-installs";
      const { result, summary, loggedArgs } = runRecipeFixture({
        scenario,
        version,
        failPath,
      });
      const failed = failPath !== undefined;
      expect(result.status, result.stdout + result.stderr).toBe(failed ? 1 : 0);
      expect(summary.acceptedIntents.includes("discord-channel")).toBe(!failed || !batched);
      expect(summary.acceptedIntents.includes("telegram-channel")).toBe(!failed);
      expect(summary.acceptedIntents.includes("validate")).toBe(!failed);
      const steps = baselineSteps(scenario, version);
      expect(loggedArgs).toEqual(
        (failed ? steps.slice(0, batched ? 9 : 10) : steps).map((step) => step.argv),
      );
      if (failed) {
        expect(summary.steps.slice(0, -1).every((step: { ok: boolean }) => step.ok)).toBe(true);
        const id = batched ? "channels" : "channels-telegram";
        expect(summary.steps.at(-1)).toMatchObject({ id, ok: false, status: 17 });
        expect(result.stderr).toContain(`baseline config recipe failed at ${id}: 17`);
      } else {
        expect(summary.steps.find((step: { id: string }) => step.id === "channels")).toMatchObject({
          id: "channels",
          ok: true,
          status: 0,
          intents: ["discord-channel", "telegram-channel", "whatsapp-channel"],
        });
      }
    },
  );
});
