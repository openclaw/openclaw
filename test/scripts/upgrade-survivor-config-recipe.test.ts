import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  resolveScenarioConfigSteps,
  resolveUpgradeSurvivorConfigSteps,
  resolveUpgradeSurvivorConfigStepsForBaseline,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { buildInlineProviderModels } from "../../src/agents/embedded-agent-runner/model.inline-provider.js";
import { AgentsSchema } from "../../src/config/zod-schema.agents.js";
import { ModelsConfigSchema } from "../../src/config/zod-schema.core.js";

const RECIPE_PATH = "scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
const RUN_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";
const DOCKER_RUNNER_PATH = "scripts/e2e/upgrade-survivor-docker.sh";

function configLeafWrites(steps: ReturnType<typeof resolveUpgradeSurvivorConfigSteps>) {
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

function runRecipeFixture(params: {
  version: string | null;
  scenario: string;
  entrypoint?: string;
  failPath?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-recipe-"));
  try {
    const binDir = join(root, "bin");
    const logPath = join(root, "openclaw-argv.jsonl");
    const summaryPath = join(root, "summary.json");
    const legacyMarker = join(root, "legacy-seeded");
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
    let command = process.execPath;
    let cwd = process.cwd();
    let args = [
      "--import",
      "tsx",
      RECIPE_PATH,
      "apply",
      "--summary",
      summaryPath,
      ...(params.version === null ? [] : ["--baseline-version", params.version]),
    ];
    if (params.entrypoint === "survivor shell") {
      // Source mounts contain the recipe closure, but no host dependency tree.
      for (const file of [
        RECIPE_PATH,
        "scripts/e2e/lib/upgrade-survivor/config-recipe",
        "scripts/lib/release-version.mjs",
        "scripts/windows-cmd-helpers.mjs",
      ]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        cpSync(file, join(root, file), { recursive: true });
      }
      const launcher = readFileSync(RUN_PATH, "utf8").match(
        /^apply_baseline_config_recipe\(\) \{[\s\S]*?^\}/mu,
      )?.[0];
      expect(launcher).toBeTruthy();
      const legacyStub =
        params.scenario === "legacy-operator-state"
          ? `
node() {
  test "$1" = scripts/e2e/lib/upgrade-survivor/assertions.mjs
  test "$2" = seed-legacy-operator
  printf seeded > "$RECIPE_LEGACY_MARKER"
}
`
          : "";
      command = "bash";
      cwd = root;
      args = [
        "-c",
        `set -euo pipefail\nsource "$1"\n${legacyStub}\n${launcher}\nSCENARIO="$OPENCLAW_UPGRADE_SURVIVOR_SCENARIO"\nCONFIG_COVERAGE_JSON="$2"\nbaseline_version="$3"\napply_baseline_config_recipe`,
        "survivor-recipe",
        join(process.cwd(), "scripts/lib/openclaw-e2e-instance.sh"),
        summaryPath,
        params.version ?? "",
      ];
    }
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_STATE_DIR: join(root, "state"),
        OPENCLAW_CONFIG_PATH: join(root, "config.json"),
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: params.scenario,
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL: "",
        RECIPE_FAIL_PATH: params.failPath ?? "",
        RECIPE_LEGACY_MARKER: legacyMarker,
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
      summary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null,
      legacySeeded: existsSync(legacyMarker),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("upgrade survivor config recipe command resolution", () => {
  it("selects the prerelease update channel for the plugin registry", () => {
    const runner = readFileSync(RUN_PATH, "utf8");
    expect(runner).toContain('OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="beta"');
    expect(runner).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION");
  });

  it.skipIf(process.platform === "win32").each([
    { liveEnv: {}, expectedKeys: [] },
    { liveEnv: { OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1" }, expectedKeys: ["OPENAI_API_KEY"] },
    {
      liveEnv: {
        OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS:
          "openai/gpt-5.5 anthropic/claude-opus-5 google/gemini-3.1-pro-preview",
      },
      expectedKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
    },
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
      const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-upgrade-docker-boundary-")));
      const harnessRoot = realpathSync(process.cwd());
      try {
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
        expect(result.status, result.stdout + result.stderr).toBe(0);
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
        expect(args).toContain(
          "OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC=/tmp/openclaw-current.tgz",
        );
        expect(args.slice(-5)).toEqual([
          "timeout",
          "--kill-after=30s",
          "1200s",
          "bash",
          "/tmp/openclaw-upgrade-survivor-run.sh",
        ]);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
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

  it("keeps POSIX openclaw invocations direct", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(["config", "validate"], {
        platform: "linux",
      }),
    ).toEqual({
      args: ["config", "validate"],
      command: "openclaw",
      commandLabel: "openclaw config validate",
      shell: false,
    });
  });

  it("adds the Codex allowlist survival scenario", () => {
    expect(resolveScenarioConfigSteps("codex-allowlist-survival")).toEqual([
      {
        argv: [
          "config",
          "set",
          "plugins.allow",
          JSON.stringify([
            "anthropic",
            "google",
            "openai",
            "discord",
            "memory",
            "telegram",
            "whatsapp",
            "codex",
          ]),
          "--strict-json",
        ],
        id: "plugins-codex-allowlist",
        intent: "codex-allowlist-survival",
      },
    ]);
  });

  it.each([
    ["base", undefined, "stable"],
    ["base", "beta", "beta"],
    ["prerelease-plugin-registry", undefined, "beta"],
  ])(
    "keeps the %s scenario on the %s override update channel",
    (scenario, channel, expectedChannel) => {
      const updateChannels = resolveUpgradeSurvivorConfigSteps(scenario, channel)
        .filter((step) => step.argv.slice(0, 3).join(" ") === "config set update.channel")
        .map((step) => step.argv[3]);

      expect(updateChannels.at(-1)).toBe(expectedChannel);
    },
  );

  it("inserts scenario config before final validation", () => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("feishu-channel", "2026.6.1");
    const gateway = JSON.parse(steps.find((step) => step.id === "gateway")?.argv[3] ?? "{}");
    expect(gateway.reload).toEqual({ mode: "off" });
    expect(steps.find((step) => step.id === "channels-discord")).toBeDefined();
    expect(steps.find((step) => step.id === "channels-feishu")).toBeDefined();
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("enables private integrity file logging only for the base recipe before validation", () => {
    const { result, loggedArgs, summary } = runRecipeFixture({
      scenario: "base",
      version: "2026.9.4",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(summary.acceptedIntents).toContain("logging");
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-logging-"));
    try {
      const config = join(root, "config.json");
      const coverage = join(root, "coverage.json");
      writeFileSync(
        config,
        JSON.stringify({
          logging: Object.fromEntries(
            loggedArgs.flatMap((args) =>
              args[2]?.startsWith("logging.") ? [[args[2].slice("logging.".length), args[3]]] : [],
            ),
          ),
        }),
      );
      writeFileSync(
        coverage,
        JSON.stringify({
          acceptedIntents: summary.acceptedIntents.filter((intent: string) => intent === "logging"),
        }),
      );
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
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    expect(loggedArgs.slice(-3)).toEqual([
      ["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"],
      ["config", "set", "logging.level", "debug"],
      ["config", "validate"],
    ]);
    expect(loggedArgs.some((args) => args[2]?.startsWith("logging.console"))).toBe(false);
    expect(
      resolveUpgradeSurvivorConfigSteps("tilde-log-path")
        .filter((step) => step.intent === "logging")
        .map((step) => step.argv),
    ).toEqual([["config", "set", "logging.file", "~/openclaw-upgrade-survivor/gateway.jsonl"]]);
    expect(
      resolveUpgradeSurvivorConfigSteps("feishu-channel").some((step) => step.intent === "logging"),
    ).toBe(false);
  });

  it.each([null, "2026.6.1", "2026.8.1", "2026.9.5"])(
    "authors schema-valid provider credentials without changing the primary model for %s",
    (version) => {
      const writes = configLeafWrites(
        resolveUpgradeSurvivorConfigStepsForBaseline("base", version),
      );
      const providers = Object.fromEntries(
        writes
          .filter((entry) => entry.path.startsWith("models.providers."))
          .map((entry) => [entry.path.slice("models.providers.".length), entry.value]),
      );
      expect(ModelsConfigSchema.safeParse({ providers }).success).toBe(true);
      expect(providers).toEqual({
        openai: {
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
        anthropic: {
          api: "anthropic-messages",
          apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
          baseUrl: "https://api.anthropic.com",
          models: [],
        },
        google: {
          api: "google-generative-ai",
          apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          models: [
            {
              id: "gemini-3.1-pro-preview",
              name: "Gemini 3.1 Pro Preview",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
            },
          ],
        },
      });
      expect(writes.find((entry) => entry.path === "agents")?.value).toMatchObject({
        defaults: { model: { primary: "openai/gpt-5.5" } },
      });
      const googleStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "models-google",
      );
      const google = JSON.parse(googleStep?.argv[3] ?? "{}");
      expect(buildInlineProviderModels({ google })).toEqual([
        expect.objectContaining({
          provider: "google",
          id: "gemini-3.1-pro-preview",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          reasoning: true,
          contextWindow: 1048576,
          maxTokens: 65536,
        }),
      ]);
    },
  );

  it.each([
    "base",
    "feishu-channel",
    "configured-plugin-installs",
    "sqlite-volume",
    "acpx-openclaw-tools-bridge",
    "codex-allowlist-survival",
  ])("keeps all configured provider owners allowed in the %s recipe", (scenario) => {
    for (const version of ["2026.6.1", "2026.8.1", "2026.9.5"]) {
      let allow: string[] = [];
      for (const step of resolveUpgradeSurvivorConfigStepsForBaseline(scenario, version)) {
        if (step.argv[2] === "plugins") {
          allow = JSON.parse(step.argv[3] ?? "{}").allow;
        } else if (step.argv[2] === "plugins.allow") {
          allow = JSON.parse(step.argv[3] ?? "[]");
        }
      }
      expect(allow).toEqual(expect.arrayContaining(["anthropic", "google", "openai"]));
    }
  });

  it("keeps the watch direct-node recipe isolated from unrelated plugin fixtures", () => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("watchos-direct-node", "2026.6.34");
    const intents = steps.map((step) => step.intent);

    expect(intents).toEqual(["update", "gateway", "validate"]);
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("uses password auth for mobile pairing reconnect coverage", () => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline(
      "mobile-pairing-reconnect",
      "2026.6.34",
    );
    const gateway = JSON.parse(steps.find((step) => step.id === "gateway")?.argv[3] ?? "{}");

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

  it.each([
    { version: "2026.6.1", legacy: true, explicit: false },
    { version: "2026.7.1-2", legacy: true, explicit: false },
    { version: "2026.7.2-beta.3", legacy: true, explicit: false },
    { version: "2026.7.2-beta.4", legacy: false, explicit: false },
    { version: "2026.7.2-beta.5", legacy: false, explicit: false },
    { version: "2026.7.2", legacy: false, explicit: false },
    { version: "2026.7.33", legacy: true, explicit: false },
    { version: "2026.7.34", legacy: true, explicit: false },
    { version: "2026.7.35", legacy: true, explicit: false },
    { version: "2026.7.36", legacy: true, explicit: false },
    { version: "2026.8.1-beta.1", legacy: false, explicit: false },
    { version: "2026.8.1-beta.2", legacy: false, explicit: true },
    { version: "2026.8.1", legacy: false, explicit: true },
    { version: null, legacy: false, explicit: true },
  ])(
    "authors one version-correct recovery roster for $version",
    ({ version, legacy, explicit }) => {
      const steps = resolveUpgradeSurvivorConfigStepsForBaseline("recovery-cleanup", version);
      const agentSteps = steps.filter(
        (step) =>
          step.argv[0] === "config" && step.argv[1] === "set" && step.argv[2]?.startsWith("agents"),
      );
      expect(agentSteps).toHaveLength(1);
      expect(agentSteps[0]?.argv.slice(0, 3)).toEqual(["config", "set", "agents"]);
      const agents = JSON.parse(agentSteps[0]?.argv[3] ?? "{}");
      expect(legacy ? agents.entries : agents.list).toBeUndefined();
      const ids = legacy
        ? agents.list.map((agent: { id: string }) => agent.id)
        : Object.keys(agents.entries);
      expect(ids).toEqual(["main", "ops", "recovery-clean", "recovery-protected"]);
      const ops = legacy
        ? agents.list.find((agent: { id: string }) => agent.id === "ops")
        : agents.entries.ops;
      expect(ops.fastModeDefault).toBe(true);
      expect(agents.defaults.heartbeat.every).toBe("0m");
      if (!explicit) {
        expect(agents.ownership).toBeUndefined();
        const entries: Record<string, { default?: boolean }> = legacy
          ? Object.fromEntries(agents.list.map(({ id, ...entry }: { id: string }) => [id, entry]))
          : agents.entries;
        expect(Object.entries(entries).filter(([, entry]) => entry.default)).toEqual([
          ["main", expect.objectContaining({ default: true })],
        ]);
      } else {
        expect(agents.ownership).toBe("explicit");
        expect(AgentsSchema.safeParse(agents).success).toBe(true);
      }
      const baseStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const baseAgents = JSON.parse(baseStep?.argv[3] ?? "{}");
      expect(
        legacy
          ? baseAgents.list.map((agent: { id: string }) => agent.id)
          : Object.keys(baseAgents.entries),
      ).toEqual(["main", "ops"]);
      expect(configLeafWrites(steps)).toContainEqual({
        path: "channels.whatsapp",
        value: JSON.parse(
          readFileSync(
            "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-whatsapp.json",
            "utf8",
          ),
        ),
      });
      expect(steps.at(-1)?.id).toBe("validate");
    },
  );

  it("authors a schema-valid roster at the explicit ownership boundary", () => {
    const version = "2026.8.1-beta.2";
    const agentStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
      (step) => step.id === "agents",
    );
    const agents = JSON.parse(agentStep?.argv[3] ?? "{}");
    expect(AgentsSchema.safeParse(agents).success).toBe(true);
    expect(agents.ownership).toBe("explicit");
    expect(agents.defaults.heartbeat.every).toBe("0m");
    expect(Object.keys(agents.entries)).toEqual(["main", "ops"]);
    expect(agents.entries.ops.fastModeDefault).toBe(true);
  });

  it.each(["2026.6.1", "2026.6.34", "2026.6.35", "2026.7.2-beta.3", "2026.7.33"])(
    "preserves the legacy agent contract for baseline %s",
    (version) => {
      const agentStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const agents = JSON.parse(agentStep?.argv[3] ?? "{}");
      expect(agents.ownership).toBeUndefined();
      expect(agents.entries).toBeUndefined();
      expect(agents.list.map((agent: { id: string }) => agent.id)).toEqual(["main", "ops"]);
      expect(agents.list.filter((agent: { default?: boolean }) => agent.default)).toEqual([
        expect.objectContaining({ id: "main" }),
      ]);
      expect(agents.list[1].fastModeDefault).toBe(true);
    },
  );

  it.each([
    { version: null, batched: false },
    { version: "unknown", batched: false },
    { version: "2026.6.1", batched: false },
    { version: "2026.6.33", batched: false },
    { version: "2026.6.34-beta.1", batched: false },
    { version: "2026.6.34-1", batched: false },
    { version: "2026.6.34", batched: true },
  ])("batches only supported final baselines: $version", ({ version, batched }) => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("base", version);
    expect(steps).toHaveLength(batched ? 12 : 14);
    expect(steps.filter((step) => step.argv[2] === "--batch-json")).toHaveLength(batched ? 1 : 0);
    expect(configLeafWrites(steps).filter((entry) => entry.path.startsWith("channels."))).toEqual([
      expect.objectContaining({ path: "channels.discord" }),
      expect.objectContaining({ path: "channels.telegram" }),
      expect.objectContaining({ path: "channels.whatsapp" }),
    ]);
    expect(steps.flatMap((step) => step.intents ?? [step.intent])).toEqual([
      "update",
      "gateway",
      "models",
      "models-anthropic",
      "models-google",
      "agents",
      "skills",
      "plugins",
      "discord-channel",
      "telegram-channel",
      "whatsapp-channel",
      "logging",
      "logging",
      "validate",
    ]);
  });

  it.each([
    { version: "2026.6.34", legacyDm: true },
    { version: "2026.7.2", legacyDm: false },
  ])("batches the adapted channel fixtures for $version", ({ version, legacyDm }) => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("base", version);
    const expected = ["discord", "telegram", "whatsapp"].map((channel) => ({
      path: `channels.${channel}`,
      value: JSON.parse(
        readFileSync(
          `scripts/e2e/lib/upgrade-survivor/config-recipe/channels-${channel}.json`,
          "utf8",
        ),
      ),
    }));
    if (legacyDm) {
      const { dmPolicy, allowFrom, ...discord } = expected[0]!.value;
      expected[0]!.value = { ...discord, dm: { policy: dmPolicy, allowFrom } };
    }
    const batch = steps.find((step) => step.id === "channels");
    expect(batch?.argv.slice(0, 3)).toEqual(["config", "set", "--batch-json"]);
    expect(JSON.parse(batch?.argv[3] ?? "[]")).toEqual(expected);
  });

  it("bounds baseline config commands and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const outcome = runUpgradeSurvivorOpenClawStep(
      {
        argv: ["config", "validate"],
        id: "validate",
        intent: "validate",
      },
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

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ["config", "validate"],
      command: "openclaw",
      options: {
        killSignal: "SIGTERM",
        maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
        timeout: CONFIG_COMMAND_TIMEOUT_MS,
      },
    });
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

  it.each(process.platform === "win32" ? ["recipe CLI"] : ["recipe CLI", "survivor shell"])(
    "authors supported ACPX bridge config through the %s",
    (entrypoint) => {
      const { result, summary, loggedArgs } = runRecipeFixture({
        entrypoint,
        scenario: "acpx-openclaw-tools-bridge",
        version: "2026.6.1",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(summary.acceptedIntents).toContain("acpx-openclaw-tools-bridge");
      expect(summary.baselineVersion).toBe("2026.6.1");
      expect(loggedArgs.at(-1)).toEqual(["config", "validate"]);
      expect(loggedArgs).toContainEqual(
        expect.arrayContaining([
          "set",
          "plugins",
          expect.stringContaining("openClawToolsMcpBridge"),
        ]),
      );
    },
  );

  it("records one successful batch before overrides and final validation", () => {
    const scenario = "configured-plugin-installs";
    const version = "2026.6.34";
    const { result, summary, loggedArgs } = runRecipeFixture({ scenario, version });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline(scenario, version);
    expect(loggedArgs).toEqual(steps.map((step) => step.argv));
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual([
      "update-channel",
      "gateway",
      "models-openai",
      "models-anthropic",
      "models-google",
      "agents",
      "skills",
      "plugins",
      "channels",
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
      "update",
      "gateway",
      "models",
      "models-anthropic",
      "models-google",
      "agents",
      "skills",
      "plugins",
      "discord-channel",
      "telegram-channel",
      "whatsapp-channel",
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
      const previousIds = [
        "update-channel",
        "gateway",
        "models-openai",
        "models-anthropic",
        "models-google",
        "agents",
        "skills",
        "plugins",
      ];
      expect(summary.steps.map((step: { id: string }) => step.id)).toEqual([
        ...previousIds,
        ...(batched ? ["channels"] : ["channels-discord", "channels-telegram"]),
      ]);
      expect(summary.steps.slice(0, -1).every((step: { ok: boolean }) => step.ok)).toBe(true);
      expect(summary.steps.at(-1)).toMatchObject({
        id: batched ? "channels" : "channels-telegram",
        ok: false,
        status: 17,
      });
      expect(summary.acceptedIntents).toEqual([
        "update",
        "gateway",
        "models",
        "models-anthropic",
        "models-google",
        "agents",
        "skills",
        "plugins",
        ...(batched ? [] : ["discord-channel"]),
      ]);
      const steps = resolveUpgradeSurvivorConfigStepsForBaseline(
        "configured-plugin-installs",
        version,
      );
      expect(loggedArgs).toEqual(steps.slice(0, batched ? 9 : 10).map((step) => step.argv));
      expect(result.stderr).toContain(
        `baseline config recipe failed at ${batched ? "channels" : "channels-telegram"}: 17`,
      );
    },
  );

  it.skipIf(process.platform === "win32")("preserves the operator-state recipe bypass", () => {
    const { result, summary, loggedArgs, legacySeeded } = runRecipeFixture({
      entrypoint: "survivor shell",
      scenario: "legacy-operator-state",
      version: "2026.6.34",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(legacySeeded).toBe(true);
    expect(summary).toBeNull();
    expect(loggedArgs).toEqual([]);
  });
});
