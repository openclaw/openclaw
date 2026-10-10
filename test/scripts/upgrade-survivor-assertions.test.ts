// Upgrade Survivor Assertions tests cover upgrade survivor assertions script behavior.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { UPGRADE_SURVIVOR_ASSERTION_SCENARIOS } from "../../scripts/lib/upgrade-survivor-policy.mjs";
import { readLegacySessionStoreEntries } from "../../src/config/sessions/legacy-store-inspection.js";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import type { PluginUpdateOutcome } from "../../src/plugins/update.js";
import { withEnv } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  writePluginInspectFixture,
  type PluginInspectFixture,
} from "./plugin-inspect.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
// Extracted and sourced snippets do not execute the production Darwin Bash fallback.
const testBashExecPath = process.platform === "darwin" ? "/bin/bash" : "bash";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function selectFrozenUpgradeOracle(
  root: string,
  version: string,
  baseline = "openclaw@2026.8.35",
  workingVersion?: string,
) {
  const selectedRoot = join(root, "selected");
  const selectedScenario = join(selectedRoot, "scripts/e2e/lib/upgrade-survivor");
  const selectedOracle = join(selectedRoot, ASSERTIONS_PATH);
  mkdirSync(join(selectedOracle, ".."), { recursive: true });
  writeFileSync(join(selectedRoot, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    selectedOracle,
    'throw new Error("selected oracle has no serving-turn command");\n',
  );
  writeFileSync(join(selectedScenario, "run.sh"), "# selected scenario runner\n");
  for (const path of [
    "scripts/lib/npm-publish-plan.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/bounded-response.mjs",
    "scripts/e2e/lib/plugin-index-sqlite.mjs",
    "scripts/e2e/lib/env-limits.mjs",
    "scripts/e2e/lib/text-file-utils.mjs",
  ]) {
    mkdirSync(join(selectedRoot, path, ".."), { recursive: true });
    writeFileSync(join(selectedRoot, path), "// selected release helper\n");
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", selectedRoot, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "selected release contract",
  );
  const selectedSha = git("rev-parse", "HEAD");
  if (workingVersion) {
    writeFileSync(join(selectedRoot, "package.json"), JSON.stringify({ version: workingVersion }));
  }
  const source = readFileSync("scripts/e2e/upgrade-survivor-docker.sh", "utf8");
  const policy = source.slice(
    source.indexOf("UPGRADE_SCENARIO_ARGS=()"),
    source.indexOf("\nIMAGE_NAME="),
  );
  const result = spawnSync(
    testBashExecPath,
    [
      "-euo",
      "pipefail",
      "-c",
      `
source "$HARNESS_ROOT_DIR/scripts/lib/frozen-target-compat.sh"
${policy}
printf '%s\\n' "\${UPGRADE_SCENARIO_DIR:-$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor}/assertions.mjs"
printf '%s\\n' "$UPGRADE_RUNNER"
printf '%s\\n' "$UPGRADE_TRUSTED_ASSERTIONS"
printf '%s\\n' "$UPGRADE_TRUSTED_DIAGNOSTICS"
printf '%s\\n' \${UPGRADE_SCENARIO_ARGS[@]+"\${UPGRADE_SCENARIO_ARGS[@]}"}
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ROOT_DIR: selectedRoot,
        HARNESS_ROOT_DIR: process.cwd(),
        OPENCLAW_SELECTED_SHA: selectedSha,
        OPENCLAW_TOOLING_SHA: "f".repeat(40),
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: baseline,
        TMPDIR: root,
      },
    },
  );
  const [oracle, runner, trustedAssertions, trustedDiagnostics, ...mounts] = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  const stagedScenario = mounts[0] === "-v" ? mounts[1]?.split(":", 1)[0] : undefined;
  return {
    result,
    oracle,
    runner,
    trustedAssertions,
    trustedDiagnostics,
    mounts,
    selectedOracle,
    selectedScenario,
    stagedScenario,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const RECOVERABLE_UPDATE = {
  status: "error",
  mode: "npm",
  reason: "post-update-plugins",
  before: { version: "2026.7.1-2" },
  after: { version: "2026.8.1" },
  steps: [
    { name: "global update", exitCode: 0 },
    { name: "global install swap", exitCode: 0 },
    { name: "openclaw doctor", exitCode: 0 },
  ],
  postUpdate: {
    plugins: {
      status: "error",
      changed: false,
      reason: "post-plugin-doctor-invalid-config",
      warnings: [
        {
          reason:
            'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.',
          message:
            'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.',
        },
        {
          reason: "Config remained invalid after updated plugin migrations.",
          message:
            "Post-update plugin migration did not produce a valid config; refusing to restart.",
        },
      ],
      sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
      npm: { changed: false, outcomes: [] },
      integrityDrifts: [],
    },
  },
};

function runJsonAssertion(command: string, value: unknown, ...args: string[]) {
  return runJsonTextAssertion(command, `${JSON.stringify(value, null, 2)}\n`, ...args);
}

function runJsonTextAssertion(command: string, contents: string, ...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-json-"));
  const file = join(root, "result.json");
  writeFileSync(file, contents);
  const result = spawnSync(
    testNodeExecPath,
    [
      ASSERTIONS_PATH,
      command,
      file,
      ...args,
      ...(command === "assert-recoverable-update-json" ? ["", "2026.7.1-2"] : []),
    ],
    {
      encoding: "utf8",
    },
  );
  rmSync(root, { force: true, recursive: true });
  return result;
}

function runPrefixedJsonAssertion(command: string, value: unknown, ...args: string[]) {
  return runJsonTextAssertion(
    command,
    `Stopped legacy service before update\n${JSON.stringify(value)}\n`,
    ...args,
  );
}

function withPluginResult(patch: Record<string, unknown>) {
  return {
    ...RECOVERABLE_UPDATE,
    postUpdate: { plugins: { ...RECOVERABLE_UPDATE.postUpdate.plugins, ...patch } },
  };
}

function missingCodexUpdateResult(source: "npm" | "clawhub" | "fallback") {
  const finalMessage =
    source === "npm"
      ? 'Failed to install missing configured plugin "codex" from @openclaw/codex: Package not found on npm: @openclaw/codex@2026.9.4. See https://docs.openclaw.ai/tools/plugin for installable plugins.'
      : 'Failed to install missing configured plugin "codex" from clawhub:@openclaw/codex: Package not found on ClawHub.';
  const messages =
    source === "fallback"
      ? ["@openclaw/codex unavailable; using clawhub:@openclaw/codex instead.", finalMessage]
      : [finalMessage];
  const outcomes: PluginUpdateOutcome[] = [
    {
      pluginId: "discord",
      status: "updated",
      nextVersion: "2026.9.4",
      message: "Repaired Discord.",
    },
    {
      pluginId: "whatsapp",
      status: "updated",
      nextVersion: "2026.9.4",
      message: "Repaired WhatsApp.",
    },
    ...messages.map((message): PluginUpdateOutcome => ({
      pluginId: "codex",
      status: "error",
      message,
    })),
  ];
  const errors: string[] = [];
  const integrityDrifts: Array<{ pluginId: string }> = [];
  return {
    status: "ok",
    before: { version: "2026.9.2" },
    after: { version: "2026.9.4" },
    steps: [
      { name: "global update", exitCode: 0 },
      { name: "global install swap", exitCode: 0 },
      { name: "openclaw doctor", exitCode: 0 },
    ],
    run: { status: "succeeded" },
    postUpdate: {
      plugins: {
        status: "warning",
        warnings: messages.map((message) => ({
          pluginId: "codex",
          reason: message,
          message:
            'Plugin "codex" could not be updated. Run `openclaw plugins update codex` to retry.',
          guidance: ["openclaw plugins update codex"],
        })),
        sync: { errors },
        npm: { outcomes },
        integrityDrifts,
      },
    },
  };
}

describe("upgrade recovery result assertions", () => {
  describe.each(["fallback"] as const)("missing Codex (%s)", (source) => {
    const scenarioEnv = {
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-configured-plugin-migration",
    };
    const check = (report: ReturnType<typeof missingCodexUpdateResult>) =>
      withEnv(scenarioEnv, () =>
        runJsonAssertion("assert-successful-update-json", report, "2026.9.4"),
      );

    it("accepts the successful published update with its named unavailable-Codex warning", () => {
      const result = check(missingCodexUpdateResult(source));
      expect(result.status, result.stderr).toBe(0);
    });

    const invalidReports: Array<{
      name: string;
      mutate: (report: ReturnType<typeof missingCodexUpdateResult>) => void;
    }> = [
      {
        name: "Codex consent failure",
        mutate: (report) => {
          report.postUpdate.plugins.npm.outcomes = report.postUpdate.plugins.npm.outcomes.map(
            (outcome) =>
              outcome.pluginId === "codex" && outcome.status === "error"
                ? { ...outcome, code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" }
                : outcome,
          );
        },
      },
    ];
    it.each(invalidReports)("rejects $name", ({ mutate }) => {
      const report = missingCodexUpdateResult(source);
      mutate(report);
      const result = check(report);
      expect(result.status).not.toBe(0);
    });
  });

  it.each([{ name: "reversed history", change: "reverse" }])(
    "rejects missing-Codex history with $name",
    ({ change }) => {
      const report = missingCodexUpdateResult("fallback");
      const outcomes = report.postUpdate.plugins.npm.outcomes;
      const transition = outcomes[2]!;
      switch (change) {
        case "duplicate":
          outcomes.splice(2, 0, { ...transition });
          break;
        case "duplicate-final":
          transition.message = outcomes[3]!.message;
          break;
        case "reverse":
          outcomes.splice(2, 2, outcomes[3]!, transition);
          break;
        case "missing-final":
          outcomes.pop();
          break;
        case "typed":
          transition.code = "PLUGIN_CAPABILITY_CONSENT_REQUIRED";
          break;
        case "plugin":
          transition.pluginId = "slack";
          break;
        case "target":
          transition.message =
            "@openclaw/codex unavailable; using clawhub:@openclaw/other instead.";
          break;
        case "source":
          transition.message =
            "@openclaw/other unavailable; using clawhub:@openclaw/codex instead.";
          break;
        case "npm-final":
          outcomes[3]!.message =
            missingCodexUpdateResult("npm").postUpdate.plugins.npm.outcomes[2]!.message;
          report.postUpdate.plugins.warnings[1]!.reason = outcomes[3]!.message;
          break;
        case "appended":
          transition.message += " Another install failed.";
          break;
        case "guidance":
          report.postUpdate.plugins.warnings[0]!.guidance = [];
          break;
      }
      report.postUpdate.plugins.warnings[0]!.reason = transition.message;
      report.postUpdate.plugins.warnings[0]!.pluginId = transition.pluginId;
      const result = withEnv(
        { OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-configured-plugin-migration" },
        () => runJsonAssertion("assert-successful-update-json", report, "2026.9.4"),
      );
      expect(result.status).not.toBe(0);
    },
  );

  it("accepts only a completed core swap stranded on capability consent", () => {
    expect(
      runPrefixedJsonAssertion("assert-recoverable-update-json", RECOVERABLE_UPDATE, "2026.8.1")
        .status,
    ).toBe(0);
    const consentError =
      'Plugin "discord" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.';
    const consentOutcome = {
      pluginId: "discord",
      status: "error",
      code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
    };
    const typedConsentResult = withPluginResult({
      reason: undefined,
      warnings: [],
      npm: { outcomes: [consentOutcome] },
    });
    const validResults = [
      RECOVERABLE_UPDATE,
      withPluginResult({ warnings: [], sync: { errors: [consentError] } }),
      withPluginResult({ warnings: [], npm: { outcomes: [consentOutcome] } }),
      typedConsentResult,
    ];
    for (const value of validResults) {
      const result = runJsonAssertion("assert-recoverable-update-json", value, "2026.8.1");
      expect(result.status, result.stderr).toBe(0);
      expect(runJsonAssertion("assert-successful-update-json", value, "2026.8.1").status).not.toBe(
        0,
      );
    }

    const invalidResults = [
      withPluginResult({ reason: undefined }),
      ...[
        { npm: { outcomes: [consentOutcome, { ...consentOutcome, code: "INSTALL_FAILED" }] } },
        { npm: { outcomes: [{ ...consentOutcome, code: undefined }] } },
        { npm: { outcomes: [{ ...consentOutcome, pluginId: "unreviewed" }] } },
        { reason: "registry-timeout" },
        { reason: null },
      ].map((patch) => withPluginResult({ ...typedConsentResult.postUpdate.plugins, ...patch })),
      { ...RECOVERABLE_UPDATE, reason: "global-update-failed" },
      { ...RECOVERABLE_UPDATE, after: { version: "2026.7.1-2" } },
      {
        ...RECOVERABLE_UPDATE,
        steps: RECOVERABLE_UPDATE.steps.map((step, index) =>
          index === 0 ? { ...step, exitCode: 1 } : step,
        ),
      },
      { ...RECOVERABLE_UPDATE, postUpdate: { plugins: { reason: "registry-timeout" } } },
      withPluginResult({ sync: { errors: [consentError, "registry unavailable"] } }),
      withPluginResult({ npm: { outcomes: [{ status: "error", code: "EIO" }] } }),
      withPluginResult({ integrityDrifts: [{ pluginId: "discord" }] }),
      ...["sync", "npm", "integrityDrifts"].map((field) =>
        withPluginResult({ [field]: undefined }),
      ),
    ];
    for (const value of invalidResults) {
      expect(runJsonAssertion("assert-recoverable-update-json", value, "2026.8.1").status).not.toBe(
        0,
      );
    }
  });
});

function writeMigratedSessionState(stateDir: string): undefined {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  const agentDbDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(agentSessionsDir, { recursive: true });
  mkdirSync(agentDbDir, { recursive: true });

  const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
  try {
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES session_windows(session_id) ON DELETE CASCADE
      );
    `);
    const insertSession = db.prepare(`
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertEntry = db.prepare(`
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertTranscript = db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const migratedSessions = [
      {
        entry: {
          skillsSnapshot: {
            prompt: "legacy prompt survives as metadata",
          },
        },
        sessionId: "upgrade-main-session",
        sessionKey: "agent:main:main",
      },
      {
        entry: {},
        sessionId: "upgrade-direct-session",
        sessionKey: "agent:main:+15551234567",
      },
      {
        entry: {},
        sessionId: "upgrade-group-session",
        sessionKey: "agent:main:slack:channel:cupgrade",
      },
    ];
    for (const { entry, sessionId, sessionKey } of migratedSessions) {
      insertSession.run(sessionId, sessionKey, 1710000000000, 1710000000000);
      insertEntry.run(sessionKey, sessionId, JSON.stringify(entry), 1710000000000);
      insertTranscript.run(
        sessionId,
        1,
        JSON.stringify({ type: "session", id: sessionId }),
        1710000000000,
      );
    }
  } finally {
    db.close();
  }
}

function createMigratedSessionFileStore(
  options: { includePrompt?: boolean } = {},
): Record<string, Record<string, unknown>> {
  const main: Record<string, unknown> = { sessionId: "upgrade-main-session" };
  if (options.includePrompt !== false) {
    main.skillsSnapshot = {
      prompt: "legacy prompt survives as metadata",
    };
  }
  return {
    "agent:main:main": main,
    "agent:main:+15551234567": { sessionId: "upgrade-direct-session" },
    "agent:main:slack:channel:cupgrade": { sessionId: "upgrade-group-session" },
  };
}

function writeMigratedSessionFiles(
  stateDir: string,
  options: { includePrompt?: boolean } = {},
): void {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  mkdirSync(agentSessionsDir, { recursive: true });
  writeJson(join(agentSessionsDir, "sessions.json"), createMigratedSessionFileStore(options));
  for (const sessionId of [
    "upgrade-main-session",
    "upgrade-direct-session",
    "upgrade-group-session",
  ]) {
    writeFileSync(
      join(agentSessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
  }
}

function writeLegacyCacheSessionState(
  stateDir: string,
  options: { empty?: boolean; includePrompt?: boolean; replaceNodes?: boolean } = {},
) {
  const dbPath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    if (options.replaceNodes) {
      db.exec("DROP TABLE session_nodes;");
    }
    db.exec(`
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
    if (options.empty) {
      return;
    }
    const insert = db.prepare(
      "INSERT INTO cache_entries (scope, key, value_json) VALUES (?, ?, ?)",
    );
    for (const [key, entry] of Object.entries(createMigratedSessionFileStore(options))) {
      insert.run("session_entries", key, JSON.stringify(entry));
    }
  } finally {
    db.close();
  }
}

function writeLegacySessionEntriesState(stateDir: string): void {
  const dbPath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      DROP TABLE session_nodes;
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const [key, entry] of Object.entries(createMigratedSessionFileStore())) {
      const sessionId = entry.sessionId;
      if (typeof sessionId !== "string") {
        throw new TypeError(`missing fixture session id for ${key}`);
      }
      insert.run(key, sessionId, JSON.stringify(entry), 1710000000000);
    }
  } finally {
    db.close();
  }
}

function writeSharedRuntimeCaches(stateDir: string, versioned = false): void {
  const roots = ["discord", "telegram", "whatsapp"].map((plugin) =>
    join(plugin, ".openclaw-runtime-deps-copy-stale"),
  );
  if (versioned) {
    roots.push(
      ...["discord", "feishu", "telegram", "whatsapp"].map(
        (plugin) => `openclaw-2026.6.1-${plugin}`,
      ),
    );
  }
  for (const root of roots) {
    const dir = join(stateDir, "plugin-runtime-deps", root, "node_modules", "stale-sentinel");
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "package.json"), { name: "stale-sentinel", version: "0.0.0" });
  }
}

function runSessionStateAssertion(
  setup: (stateDir: string) => NodeJS.ProcessEnv | undefined,
  options: { scenario?: string; commands?: string[] } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-session-state-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    writeSharedRuntimeCaches(stateDir, options.scenario === "versioned-runtime-deps");
    const fixtureEnv = setup(stateDir);
    for (const command of options.commands ?? ["assert-state"]) {
      execFileSync(testNodeExecPath, [ASSERTIONS_PATH, command], {
        env: {
          ...process.env,
          ...fixtureEnv,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: options.scenario ?? "base",
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: "2026.6.1",
        },
        stdio: "pipe",
      });
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function seedSessionSourceFixture(stateDir: string, scenario = "base", missingPath = false) {
  const root = join(stateDir, "..");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
    OPENCLAW_TEST_WORKSPACE_DIR: join(root, "workspace"),
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
    OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "manual",
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: join(root, "artifacts"),
    OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED: "",
  };
  writeJson(env.OPENCLAW_CONFIG_PATH, { plugins: { allow: [], entries: {} } });
  // Use the production shell seed boundary before the same assertions seed used by artifact-only.
  env.OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED = execFileSync(
    testBashExecPath,
    [
      "-euc",
      `source scripts/e2e/lib/upgrade-survivor/missing-load-path.sh
SCENARIO="$OPENCLAW_UPGRADE_SURVIVOR_SCENARIO"
UPDATE_RESTART_MODE="$OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE"
baseline_version=2026.9.3
phase() { shift; "$@"; }
${missingPath ? "run_missing_load_path_fixture seed" : ""}
"$1" "$2" seed
printf '%s' "\${OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED:-}"
`,
      "survivor-session-source-seed",
      testNodeExecPath,
      ASSERTIONS_PATH,
    ],
    { env, encoding: "utf8" },
  ).trim();
  return env;
}

function assertConfiguredPluginState(params: { installPath?: string } = {}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-"));
  try {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    const matrixInstallDir = params.installPath ?? join(stateDir, "extensions", "matrix");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    mkdirSync(matrixInstallDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
    writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
      id: "legacy-session",
    });
    writeMigratedSessionState(stateDir);
    writeSharedRuntimeCaches(stateDir);
    writeJson(join(matrixInstallDir, "package.json"), {
      name: "@openclaw/matrix",
    });
    writeJson(join(stateDir, "plugins", "installs.json"), {
      installRecords: {
        matrix: {
          source: "clawhub",
          spec: "clawhub:@openclaw/matrix",
          installPath: matrixInstallDir,
          clawhubPackage: "@openclaw/matrix",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
        },
      },
      plugins: [{ pluginId: "matrix", enabled: true }],
    });
    const coveragePath = join(root, "coverage.json");
    writeJson(coveragePath, {
      acceptedIntents: ["configured-plugin-installs"],
    });

    execFileSync(testNodeExecPath, [ASSERTIONS_PATH, "assert-state"], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function assertConfig(params: {
  acceptedIntents: string[];
  baselineVersion?: string;
  config: unknown;
  scenario: string;
  stage?: "baseline" | "survival";
  updateChannel?: string;
}): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-config-"));
  try {
    const configPath = join(root, "openclaw.json");
    const coveragePath = join(root, "coverage.json");
    writeJson(configPath, params.config);
    writeJson(coveragePath, {
      acceptedIntents: params.acceptedIntents,
      baselineVersion: params.baselineVersion,
    });

    execFileSync(testNodeExecPath, [ASSERTIONS_PATH, "assert-config"], {
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: params.scenario,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: params.stage ?? "survival",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL: params.updateChannel ?? "",
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const ACCEPTED_SURFACE = {
  channels: [],
  providers: [],
  tools: [],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};

function acceptedSurfaceHash(): string {
  return createHash("sha256").update(JSON.stringify(ACCEPTED_SURFACE)).digest("hex");
}

function assertCompanionPluginRecords(
  mutate?: (
    records: Record<string, PluginInstallRecord>,
    installPaths: Record<"codex" | "discord" | "whatsapp", string>,
  ) => void,
  capabilityConsentSupported = true,
  recoveryPluginIds?: string[],
  options: {
    mutateInspection?: (inspections: Record<string, PluginInspectFixture>) => void;
    isolateAssertionRuntime?: boolean;
  } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-companions-"));
  try {
    const stateDir = join(root, "state");
    const version = "2026.8.1";
    const discordInstallPath = join(
      stateDir,
      "npm",
      "projects",
      "discord",
      "node_modules",
      "@openclaw",
      "discord",
    );
    const codexInstallPath = join(
      stateDir,
      "npm",
      "projects",
      "codex",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const whatsappInstallPath = join(stateDir, "extensions", "whatsapp");
    for (const [installPath, packageName] of [
      [discordInstallPath, "@openclaw/discord"],
      [whatsappInstallPath, "@openclaw/whatsapp"],
      [codexInstallPath, "@openclaw/codex"],
    ] as const) {
      mkdirSync(installPath, { recursive: true });
      writeJson(join(installPath, "package.json"), { name: packageName, version });
    }
    const npmIntegrity = "sha512-upgrade-survivor";
    const clawpackSha256 = "a".repeat(64);
    const consent = (integrity: string) => ({
      acceptedSurface: ACCEPTED_SURFACE,
      acceptedSurfaceHash: acceptedSurfaceHash(),
      acceptedSurfaceAt: "2026-08-27T00:00:00.000Z",
      acceptedSurfaceIntegrity: integrity,
    });
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "npm",
        spec: `@openclaw/discord@${version}`,
        resolvedName: "@openclaw/discord",
        resolvedVersion: version,
        integrity: npmIntegrity,
        installPath: discordInstallPath,
        ...(recoveryPluginIds
          ? {
              sourcePath: join(root, "unverified-plugin.tgz"),
              artifactKind: "npm-pack" as const,
              ...(capabilityConsentSupported ? consent(npmIntegrity) : {}),
            }
          : {}),
      },
      whatsapp: {
        source: "clawhub",
        spec: `clawhub:@openclaw/whatsapp@${version}`,
        version,
        clawhubPackage: "@openclaw/whatsapp",
        clawhubChannel: "official",
        clawhubUrl: "http://127.0.0.1:18765",
        artifactKind: "npm-pack",
        clawpackSha256,
        installPath: whatsappInstallPath,
        ...(capabilityConsentSupported ? consent(clawpackSha256) : {}),
      },
      codex: {
        source: "npm",
        spec: `@openclaw/codex@${version}`,
        resolvedName: "@openclaw/codex",
        resolvedVersion: version,
        integrity: npmIntegrity,
        installPath: codexInstallPath,
        ...(recoveryPluginIds
          ? {
              sourcePath: join(root, "unverified-plugin.tgz"),
              artifactKind: "npm-pack" as const,
              ...(capabilityConsentSupported ? consent(npmIntegrity) : {}),
            }
          : {}),
      },
    };
    mutate?.(records, {
      codex: codexInstallPath,
      discord: discordInstallPath,
      whatsapp: whatsappInstallPath,
    });
    mkdirSync(join(stateDir, "plugins"), { recursive: true });
    writeJson(join(stateDir, "plugins", "installs.json"), { installRecords: records });
    const updateFile = join(root, "update.json");
    if (recoveryPluginIds) {
      writeJson(updateFile, {
        ...RECOVERABLE_UPDATE,
        postUpdate: {
          plugins: {
            ...RECOVERABLE_UPDATE.postUpdate.plugins,
            warnings: recoveryPluginIds.map((pluginId) => ({
              reason: `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`,
              message: `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`,
            })),
          },
        },
      });
    }
    const bin = join(root, "bin");
    const fixtureEnv = writePluginInspectFixture(bin, records, options.mutateInspection);
    let assertionsPath = ASSERTIONS_PATH;
    if (options.isolateAssertionRuntime) {
      const isolatedScripts = join(root, "production-assertion-runtime", "scripts");
      const isolatedLib = join(isolatedScripts, "e2e", "lib");
      cpSync("scripts/e2e/lib", isolatedLib, { recursive: true });
      mkdirSync(join(isolatedScripts, "lib"), { recursive: true });
      for (const file of [
        "release-version.mjs",
        "sqlite-transcript-payload.mjs",
        "upgrade-survivor-policy.mjs",
        "upgrade-survivor-scenarios.json",
      ]) {
        cpSync(join("scripts/lib", file), join(isolatedScripts, "lib", file));
      }
      cpSync(
        "scripts/prepublish-plugin-registry-artifact.mjs",
        join(isolatedScripts, "prepublish-plugin-registry-artifact.mjs"),
      );
      cpSync("scripts/windows-cmd-helpers.mjs", join(isolatedScripts, "windows-cmd-helpers.mjs"));
      assertionsPath = join(isolatedLib, "upgrade-survivor", "assertions.mjs");
    }
    execFileSync(
      testNodeExecPath,
      [
        assertionsPath,
        ...(recoveryPluginIds
          ? ["assert-recovered-plugin-installs", updateFile, version, "", "2026.7.1-2"]
          : ["assert-companion-installs", version, capabilityConsentSupported ? "1" : "0"]),
      ],
      {
        cwd: options.isolateAssertionRuntime ? root : undefined,
        env: {
          ...process.env,
          ...fixtureEnv,
          OPENCLAW_STATE_DIR: stateDir,
          PATH: options.isolateAssertionRuntime ? "" : fixtureEnv.PATH,
        },
        stdio: "pipe",
      },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("upgrade survivor assertions", () => {
  it.each([
    ["2026.8.35", true, "openclaw@2026.9.2", ""],
    ["2026.9.3", false, "openclaw@2026.8.35", "2026.8.35"],
  ])(
    "selects upgrade assertion ownership from immutable target %s",
    (version, selected, baseline, workingVersion) => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-oracle-"));
      try {
        const proof = selectFrozenUpgradeOracle(root, version, baseline, workingVersion);
        expect(proof.result.status, proof.result.stderr).toBe(0);
        expect(proof.oracle).toBe(
          selected ? proof.selectedOracle : join(process.cwd(), ASSERTIONS_PATH),
        );
        expect(proof.runner).toBe(
          join(
            selected
              ? proof.selectedScenario
              : join(process.cwd(), "scripts/e2e/lib/upgrade-survivor"),
            "run.sh",
          ),
        );
        if (selected) {
          expect(proof.trustedAssertions).toBe(
            "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/assertions.mjs",
          );
          expect(proof.trustedDiagnostics).toBe(
            "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/diagnostics.mjs",
          );
          expect(proof.mounts.join("\n")).not.toContain("upgrade-survivor-trusted");
          expect(readFileSync(join(proof.stagedScenario!, "assertions.mjs"), "utf8")).toBe(
            readFileSync(proof.selectedOracle, "utf8"),
          );
          const artifacts = join(root, "artifacts");
          const published = join(root, "published");
          const runtimeScripts = join(root, "runtime/scripts");
          const runtimeScenario = join(runtimeScripts, "e2e/lib/upgrade-survivor");
          cpSync(proof.stagedScenario!, runtimeScenario, { recursive: true });
          mkdirSync(join(runtimeScripts, "lib"), { recursive: true });
          cpSync(
            "scripts/lib/release-version.mjs",
            join(runtimeScripts, "lib/release-version.mjs"),
          );
          mkdirSync(artifacts);
          writeJson(join(artifacts, "summary.json"), {
            status: "passed",
            baseline: { spec: baseline, version: baseline.slice("openclaw@".length) },
            candidate: { kind: "package", version },
            scenario: "base",
            installedVersion: version,
            candidateInstallMode: "updater",
            updateRestartMode: "manual",
            updateOutcome: "success",
            phases: [],
          });
          const publication = spawnSync(
            testNodeExecPath,
            [
              "--input-type=module",
              "-e",
              `import { pathToFileURL } from "node:url";
const [projector, artifacts, destination] = process.argv.slice(1);
const { publishDiagnostics } = await import(pathToFileURL(projector).href);
publishDiagnostics(artifacts, destination, value => value, "passed");`,
              join(runtimeScenario, "diagnostics.mjs"),
              artifacts,
              published,
            ],
            { encoding: "utf8", cwd: root },
          );
          expect(publication.status, publication.stderr).toBe(0);
          expect(JSON.parse(readFileSync(join(published, "summary.json"), "utf8"))).toMatchObject({
            status: "passed",
            candidate: { version },
            installedVersion: version,
          });
        }
        expect(proof.mounts).toEqual(
          selected
            ? [
                "-v",
                expect.stringMatching(
                  /openclaw-upgrade-scenario\.[^/]+:\/app\/scripts\/e2e\/lib\/upgrade-survivor:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /npm-registry-server\.mjs:\/app\/scripts\/e2e\/lib\/plugins\/npm-registry-server\.mjs:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /npm-publish-plan\.mjs:\/app\/scripts\/lib\/npm-publish-plan\.mjs:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /bounded-response\.mjs:\/app\/scripts\/lib\/bounded-response\.mjs:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /plugin-index-sqlite\.mjs:\/app\/scripts\/e2e\/lib\/plugin-index-sqlite\.mjs:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /env-limits\.mjs:\/app\/scripts\/e2e\/lib\/env-limits\.mjs:ro$/u,
                ),
                "-v",
                expect.stringMatching(
                  /text-file-utils\.mjs:\/app\/scripts\/e2e\/lib\/text-file-utils\.mjs:ro$/u,
                ),
              ]
            : [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: "legacy default-only doctor export",
      sdkPath: "runtime-doctor",
      declaresTypes: false,
      runtime: 'throw new Error("undeclared SDK must not be imported");\n',
      failure: undefined,
    },
    {
      name: "declared constructor missing at runtime",
      sdkPath: "runtime-doctor",
      declaresTypes: true,
      runtime: "export {};\n",
      failure: "declared a keyed store constructor but did not export it",
    },
    {
      name: "declared SDK import failure",
      sdkPath: "runtime-doctor",
      declaresTypes: true,
      runtime: 'throw new Error("synthetic SDK import failure");\n',
      failure: "synthetic SDK import failure",
    },
    {
      name: "dedicated default-only store export missing its constructor",
      sdkPath: "plugin-state-store-runtime",
      declaresTypes: false,
      runtime: "export {};\n",
      failure: "declared a keyed store constructor but did not export it",
    },
  ])(
    "classifies baseline shared state for $name",
    ({ sdkPath, declaresTypes, runtime, failure }) => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-baseline-sdk-"));
      try {
        const packageRoot = join(root, "package");
        const stateDir = join(root, "state");
        const version = "1.0.0";
        mkdirSync(packageRoot);
        mkdirSync(stateDir);
        writeJson(join(packageRoot, "package.json"), {
          name: "openclaw",
          version,
          type: "module",
          exports: {
            [`./plugin-sdk/${sdkPath}`]: {
              ...(declaresTypes ? { types: "./runtime-doctor.d.ts" } : {}),
              default: "./runtime-doctor.js",
            },
          },
        });
        // An undeclared sibling file must not become a guessed declaration fallback.
        writeFileSync(
          join(packageRoot, "runtime-doctor.d.ts"),
          "export declare function createPluginStateSyncKeyedStore(): unknown;\n",
        );
        writeFileSync(join(packageRoot, "runtime-doctor.js"), runtime);
        const baselinePath = join(stateDir, "survivor-baseline.json");
        writeJson(baselinePath, { marker: "existing fixture" });
        const result = spawnSync(
          testNodeExecPath,
          [
            "scripts/e2e/lib/upgrade-survivor/sqlite-volume-shared-state.mjs",
            "seed-baseline-plugin-state",
            packageRoot,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: version,
            },
          },
        );
        const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
        if (failure) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(failure);
          expect(baseline).toEqual({ marker: "existing fixture" });
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(baseline).toEqual({
            marker: "existing fixture",
            sharedState: {
              status: "not-applicable",
              packageVersion: version,
              reason: "baseline SDK does not declare createPluginStateSyncKeyedStore",
            },
          });
          expect(result.stdout).toContain("not-applicable");
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("verifies legacy auth import in the current shared owner without losing credentials or state", () => {
    const fixture = JSON.parse(
      readFileSync(
        "scripts/e2e/lib/upgrade-survivor/fixtures/auth-profile-v2026.7.2-beta.5.json",
        "utf8",
      ),
    );
    const verify = (corruption?: "credential" | "state" | "archive") =>
      runSessionStateAssertion(
        (stateDir) => {
          writeMigratedSessionState(stateDir);
          const sources = [
            ["agents/main/agent/auth-profiles.json", fixture.authProfiles],
            ["agents/main/agent/auth-state.json", fixture.authState],
            ["agents/main/agent/auth.json", fixture.legacyAuth],
            ["credentials/oauth.json", fixture.legacyOAuth],
          ] as const;
          mkdirSync(join(stateDir, "credentials"), { recursive: true });
          for (const [source, contents] of sources) {
            writeJson(
              join(stateDir, `${source}.migrated-fixture`),
              corruption === "archive" ? {} : contents,
            );
          }
          const store = {
            ...fixture.authProfiles,
            profiles: {
              ...fixture.authProfiles.profiles,
              "xai:default": fixture.legacyAuth.xai,
              "anthropic:default": {
                type: "oauth",
                provider: "anthropic",
                ...fixture.legacyOAuth.anthropic,
              },
            },
          };
          if (corruption === "credential") {
            store.profiles["anthropic:default"].access = "changed-access";
          }
          mkdirSync(join(stateDir, "state"), { recursive: true });
          const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
          try {
            db.exec(`
              CREATE TABLE config_machine_state (state_key PRIMARY KEY, value_json);
              CREATE TABLE migration_sources (migration_kind, status, removed_source);
            `);
            const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?)");
            insert.run("authProfiles.store", JSON.stringify(store));
            insert.run(
              "authProfiles.state",
              JSON.stringify(corruption === "state" ? {} : fixture.authState),
            );
            sources.forEach(() => {
              db.prepare("INSERT INTO migration_sources VALUES (?, 'completed', 1)").run(
                "auth-profile-json-to-sqlite-v2",
              );
            });
          } finally {
            db.close();
          }
        },
        { scenario: "auth-profile-v2026-7-2-beta-5" },
      );
    expect(() => verify()).not.toThrow();
    for (const corruption of ["credential", "state", "archive"] as const) {
      expect(() => verify(corruption)).toThrow(/auth (?:profile|state|archive)/);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rechecks migrated meeting state before materializing transcript exports",
    () => {
      expect(() =>
        runSessionStateAssertion(
          (stateDir) => {
            writeMigratedSessionState(stateDir);
            const archive = join(
              stateDir,
              "transcripts.migrated-fixture",
              "2026-07-01",
              "design-review",
            );
            mkdirSync(archive, { recursive: true });
            writeFileSync(
              join(archive, "transcript.jsonl"),
              ["legacy-u-1", "legacy-u-2"].map((id) => JSON.stringify({ id })).join("\n") + "\n",
            );
            writeFileSync(join(archive, "summary.md"), "Shipped transcript summary\n");
            mkdirSync(join(stateDir, "state"), { recursive: true });
            const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
            try {
              db.exec(`
              CREATE TABLE meeting_transcript_sessions (session_id, started_at, next_utterance_seq);
              INSERT INTO meeting_transcript_sessions VALUES ('design-review', '2026-07-01T10:00:00.000Z', 2);
              CREATE TABLE meeting_transcript_utterances (session_id, sequence, utterance_id, text);
              INSERT INTO meeting_transcript_utterances VALUES ('design-review', 0, 'legacy-u-1', 'First shipped transcript line');
              INSERT INTO meeting_transcript_utterances VALUES ('design-review', 1, 'legacy-u-2', 'Second shipped transcript line');
              CREATE TABLE migration_sources (migration_kind, status, removed_source, source_record_count);
              INSERT INTO migration_sources VALUES ('meeting-transcripts-files-v1', 'archived', 1, 2);
            `);
            } finally {
              db.close();
            }
            const binDir = join(stateDir, "bin");
            mkdirSync(binDir);
            writeFileSync(
              join(binDir, "openclaw"),
              `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.deepEqual(process.argv.slice(2), ["transcripts", "path", "2026-07-01/design-review", "--dir"]);
const root = process.env.OPENCLAW_STATE_DIR;
const sessionDir = path.join(root, "transcripts", "2026-07-01", "design-review");
fs.cpSync(path.join(root, "transcripts.migrated-fixture", "2026-07-01", "design-review"), sessionDir, { recursive: true });
process.stdout.write(sessionDir + "\\n");
`,
              { mode: 0o755 },
            );
            return { PATH: `${binDir}${delimiter}${process.env.PATH}` };
          },
          {
            scenario: "meeting-transcripts-sqlite",
            commands: ["assert-state", "assert-state", "assert-meeting-transcript-export"],
          },
        ),
      ).not.toThrow();
    },
  );

  it("lists the dependency-free scenario contract", () => {
    const scenarios = JSON.parse(
      execFileSync(testNodeExecPath, [ASSERTIONS_PATH, "list-scenarios"], {
        encoding: "utf8",
      }),
    ) as string[];

    expect(scenarios).toContain("base");
    expect(scenarios).toContain("codex-allowlist-survival");
    expect(scenarios).toContain("mobile-pairing-reconnect");
    expect(scenarios).toContain("acpx-openclaw-tools-bridge");
    expect(scenarios).toContain("prerelease-plugin-registry");
    expect(scenarios).toContain("sqlite-volume");
    expect(scenarios).toEqual(UPGRADE_SURVIVOR_ASSERTION_SCENARIOS);
    expect(new Set(scenarios).size).toBe(scenarios.length);
  });

  it.each([{ baselineVersion: "2026.9.7", legacy: false }])(
    "validates Tool Search at baseline $baselineVersion and after upgrade",
    ({ baselineVersion, legacy }) => {
      const run = (toolSearch: unknown, stage: "baseline" | "survival" = "survival") =>
        assertConfig({
          acceptedIntents: ["tool-search"],
          baselineVersion,
          config: { tools: { toolSearch } },
          scenario: "base",
          stage,
        });
      const baselineValue = legacy ? { mode: "code", codeTimeoutMs: 5000 } : { mode: "tools" };
      const wrongBaselineValue = legacy ? { mode: "tools" } : { mode: "code", codeTimeoutMs: 5000 };
      expect(() => run(baselineValue, "baseline")).not.toThrow();
      expect(() => run(wrongBaselineValue, "baseline")).toThrow(/Tool Search mode/);
      expect(() => run({ mode: "tools", codeTimeoutMs: 5000 }, "baseline")).toThrow(
        legacy ? /Tool Search mode/ : /legacy timeout/,
      );
      expect(() => run({ mode: "tools" })).not.toThrow();
    },
  );

  it("allows token rotation and requires each reconnect to use the newest stored token", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-mobile-pairing-evidence-"));
    const phases = ["baseline", "candidate-first", "candidate-restart", "final"];
    const hashes = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
    const files = phases.map((phase, index) => {
      const file = join(root, `${phase}.json`);
      const scopedNodeSurfaceReapproval = index > 0;
      writeJson(file, {
        phase,
        ok: true,
        health: true,
        connectedDevicePresent: true,
        pendingPairingCount: scopedNodeSurfaceReapproval ? 1 : 0,
        pendingDevicePairingCount: 0,
        pendingNodePairingCount: scopedNodeSurfaceReapproval ? 1 : 0,
        pairedDevicePresent: true,
        pairedNodePresent: true,
        nodeSurfaceReapprovalRequired: scopedNodeSurfaceReapproval,
        nodeSurfaceReapprovalExpected: scopedNodeSurfaceReapproval,
        nodeSurfaceCommandAdditions: scopedNodeSurfaceReapproval
          ? ["watch.notify", "watch.status"]
          : [],
        missingPasswordReason: true,
        missingPasswordClose1008: true,
        credentials: {
          node: {
            usedTokenHash: hashes[index],
            storedTokenHash: hashes[index + 1],
            deviceTokenReturned: true,
            tokenRotated: true,
          },
          operator: {
            usedTokenHash: hashes[0],
            storedTokenHash: hashes[0],
            deviceTokenReturned: true,
            tokenRotated: false,
          },
        },
      });
      return file;
    });
    const verify = () =>
      execFileSync(
        testNodeExecPath,
        [ASSERTIONS_PATH, "assert-mobile-pairing-evidence", ...files],
        {
          stdio: "pipe",
        },
      );
    const finalEvidenceFile = files[2];
    if (!finalEvidenceFile) {
      throw new Error("final mobile pairing evidence fixture missing");
    }

    try {
      expect(verify).not.toThrow();
      const stale = JSON.parse(readFileSync(finalEvidenceFile, "utf8"));
      stale.credentials.node.usedTokenHash = hashes[0];
      writeJson(finalEvidenceFile, stale);
      expect(verify).toThrow(/newest stored token/);
      stale.credentials.node.usedTokenHash = hashes[2];
      stale.nodeSurfaceCommandAdditions = ["watch.status", "system.run"];
      writeJson(finalEvidenceFile, stale);
      expect(verify).toThrow(/known command-surface reapproval/);
      stale.nodeSurfaceCommandAdditions = [];
      stale.pendingPairingCount = 0;
      stale.pendingNodePairingCount = 0;
      stale.nodeSurfaceReapprovalRequired = false;
      writeJson(finalEvidenceFile, stale);
      expect(verify).toThrow(/known command-surface reapproval/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["base"])("seeds recent ordered session timestamps for %s", (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-seed-"));
    try {
      const stateDir = join(root, "state");
      const workspace = join(root, "workspace");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });

      const beforeSeed = Date.now();
      execFileSync(testNodeExecPath, [ASSERTIONS_PATH, "seed"], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_WORKSPACE_DIR: workspace,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
        },
        stdio: "pipe",
      });
      const afterSeed = Date.now();

      const sessionsDir = join(stateDir, "agents", "main", "sessions");
      const otherStore = join(stateDir, "sessions", "sessions.json");
      expect(() => readFileSync(otherStore)).toThrow(/ENOENT/);
      const storePath = join(sessionsDir, "sessions.json");
      const original = readFileSync(storePath, "utf8");
      const sessions = JSON.parse(original) as Record<
        string,
        { sessionId?: unknown; sessionFile?: unknown; updatedAt?: unknown }
      >;
      const keys = [
        "agent:main:main",
        "agent:main:+15551234567",
        "agent:main:slack:channel:cupgrade",
      ];
      expect(Object.keys(sessions)).toEqual(keys);
      const issues: Parameters<typeof readLegacySessionStoreEntries>[1] = [];
      const admitted = readLegacySessionStoreEntries({ storePath }, issues);
      expect(issues).toEqual([]);
      expect(admitted.entries.map(({ sessionKey }) => sessionKey)).toEqual(keys);
      for (const { entry } of admitted.entries) {
        expect(entry).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
      }
      expect(readFileSync(storePath, "utf8")).toBe(original);
      const seededRows = keys.map((key) => sessions[key]);
      expect(seededRows.map((row) => row?.sessionId)).toEqual([
        "upgrade-main-session",
        "upgrade-direct-session",
        "upgrade-group-session",
      ]);

      for (const row of seededRows) {
        assert(row);
        const transcriptPath = join(sessionsDir, `${String(row.sessionId)}.jsonl`);
        expect(row.sessionFile).toBe(transcriptPath);
        expect(JSON.parse(readFileSync(transcriptPath, "utf8")).id).toBe(row.sessionId);
      }

      const timestamps = seededRows.map((row) => row?.updatedAt);
      for (const timestamp of timestamps) {
        expect(typeof timestamp).toBe("number");
      }
      const [mainUpdatedAt, directUpdatedAt, groupUpdatedAt] = timestamps as [
        number,
        number,
        number,
      ];
      expect(directUpdatedAt - mainUpdatedAt).toBe(100);
      expect(groupUpdatedAt - mainUpdatedAt).toBe(200);
      expect(mainUpdatedAt).toBeLessThan(directUpdatedAt);
      expect(directUpdatedAt).toBeLessThan(groupUpdatedAt);

      const dayMs = 24 * 60 * 60 * 1000;
      const thirtyDaysMs = 30 * dayMs;
      for (const [timestamp, offset] of [
        [mainUpdatedAt, 0],
        [directUpdatedAt, 100],
        [groupUpdatedAt, 200],
      ] as const) {
        expect(timestamp).toBeGreaterThanOrEqual(beforeSeed - dayMs + offset);
        expect(timestamp).toBeLessThanOrEqual(afterSeed - dayMs + offset);
        expect(timestamp).toBeGreaterThan(afterSeed - thirtyDaysMs);
        expect(timestamp).toBeLessThanOrEqual(afterSeed);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires every seeded legacy cron specimen before update", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-cron-"));
    try {
      const stateDir = join(root, "state");
      const workspace = join(root, "workspace");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "cron-scheduled-authority",
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: "baseline",
      };
      const run = (command: string) =>
        spawnSync(testNodeExecPath, [ASSERTIONS_PATH, command], { env, encoding: "utf8" });
      const seeded = run("seed");
      expect(seeded.status, seeded.stderr).toBe(0);
      const cronStore = join(stateDir, "cron", "jobs.json");
      const baseline = run("assert-state");
      expect(baseline.status, baseline.stderr).toBe(0);
      const store = JSON.parse(readFileSync(cronStore, "utf8"));
      store.jobs.pop();
      writeJson(cronStore, store);
      const missingRow = run("assert-state");
      expect(missingRow.status).not.toBe(0);
      expect(missingRow.stderr).toContain("legacy cron authority fixture row count changed");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("allows legacy Discord DM config only at the baseline stage", () => {
    const legacyConfig = {
      channels: {
        discord: {
          enabled: true,
          dm: { policy: "allowlist", allowFrom: ["111111111111111111"] },
          guilds: {
            "222222222222222222": {
              channels: { "333333333333333333": { requireMention: true } },
            },
          },
          threadBindings: { idleHours: 72 },
        },
      },
    };
    expect(() =>
      assertConfig({
        acceptedIntents: ["discord-channel"],
        config: legacyConfig,
        scenario: "base",
        stage: "baseline",
      }),
    ).not.toThrow();
    expect(() =>
      assertConfig({
        acceptedIntents: ["discord-channel"],
        config: legacyConfig,
        scenario: "base",
      }),
    ).toThrow(/legacy Discord DM config survived/);
  });

  it("uses installed plugin inspection without repository development dependencies", () => {
    expect(() =>
      assertCompanionPluginRecords(undefined, true, undefined, { isolateAssertionRuntime: true }),
    ).not.toThrow();
  });

  it("validates recorded acceptance on verified official companions", () => {
    const recordAcceptance = (records: Record<string, PluginInstallRecord>) => {
      Object.assign(records.discord!, {
        acceptedSurface: ACCEPTED_SURFACE,
        acceptedSurfaceHash: acceptedSurfaceHash(),
        acceptedSurfaceAt: "2026-08-27T00:00:00.000Z",
        acceptedSurfaceIntegrity: records.discord!.integrity,
      });
    };
    expect(() => assertCompanionPluginRecords(recordAcceptance)).not.toThrow();
    expect(() =>
      assertCompanionPluginRecords((records) => {
        recordAcceptance(records);
        Reflect.deleteProperty(records.discord!, "acceptedSurfaceIntegrity");
      }),
    ).toThrow(/discord plugin consent integrity/);
    expect(() =>
      assertCompanionPluginRecords((records) => {
        records.discord!.acceptedSurfaceHash = "partial";
      }),
    ).toThrow(/discord plugin accepted surface missing/);
  });

  it("requires exact artifact-bound consent for custom ClawHub companions", () => {
    expect(() =>
      assertCompanionPluginRecords((records) => {
        Reflect.deleteProperty(records.whatsapp!, "acceptedSurfaceIntegrity");
      }),
    ).toThrow(/whatsapp plugin consent integrity/);
    expect(() =>
      assertCompanionPluginRecords((records) => {
        records.whatsapp!.acceptedSurfaceHash = "incorrect";
      }),
    ).toThrow(/whatsapp plugin consent hash changed/);
    expect(() =>
      assertCompanionPluginRecords((records) => {
        Reflect.deleteProperty(records.whatsapp!, "acceptedSurface");
      }),
    ).toThrow(/whatsapp plugin accepted surface missing/);
  });

  it("rejects unaccepted custom ClawHub and unverified npm companion records", () => {
    expect(() =>
      assertCompanionPluginRecords((records) => {
        for (const field of [
          "acceptedSurface",
          "acceptedSurfaceHash",
          "acceptedSurfaceAt",
          "acceptedSurfaceIntegrity",
        ]) {
          Reflect.deleteProperty(records.whatsapp!, field);
        }
      }),
    ).toThrow(/whatsapp plugin accepted surface missing/);
    expect(() =>
      assertCompanionPluginRecords((records) => {
        records.discord!.artifactKind = "npm-pack";
      }),
    ).toThrow(/discord plugin accepted surface missing/);
  });

  it.each([
    ["spec", "@openclaw/discord@file:payload"],
    ["resolvedSpec", "@openclaw/discord@git+https://example.invalid/discord.git"],
  ] as const)("rejects an official-looking non-registry %s", (field, value) => {
    expect(() =>
      assertCompanionPluginRecords((records) => {
        records.discord![field] = value;
      }),
    ).toThrow(/discord plugin accepted surface missing/);
  });

  it("binds trusted inspection to the same plugin, package, root, and install record", () => {
    expect(() =>
      assertCompanionPluginRecords(undefined, true, undefined, {
        mutateInspection: (inspections) => {
          inspections.discord!.plugin.id = "unrelated";
        },
      }),
    ).toThrow(/discord inspected plugin id changed/);
    expect(() =>
      assertCompanionPluginRecords(undefined, true, undefined, {
        mutateInspection: (inspections) => {
          inspections.discord!.plugin.packageName = "@example/unrelated";
        },
      }),
    ).toThrow(/discord inspected package name changed/);
    expect(() =>
      assertCompanionPluginRecords(undefined, true, undefined, {
        mutateInspection: (inspections) => {
          inspections.discord!.plugin.rootDir = inspections.whatsapp!.plugin.rootDir;
        },
      }),
    ).toThrow(/discord inspected install path changed/);
    expect(() =>
      assertCompanionPluginRecords(undefined, true, undefined, {
        mutateInspection: (inspections) => {
          inspections.discord!.install.integrity = "different-artifact";
        },
      }),
    ).toThrow(/discord inspected install record changed/);
  });

  it("requires artifact-bound consent for every published recovery plugin", () => {
    const ids = ["codex", "discord", "whatsapp"];
    expect(() => assertCompanionPluginRecords(undefined, true, ids)).not.toThrow();
    for (const id of ids) {
      expect(() =>
        assertCompanionPluginRecords(
          (records) => {
            records[id]!.acceptedSurfaceHash = "incorrect";
          },
          true,
          ids,
        ),
      ).toThrow(/plugin consent hash changed/);
      expect(() =>
        assertCompanionPluginRecords(
          (records) => {
            records[id]!.acceptedSurfaceIntegrity = "different-artifact";
          },
          true,
          ids,
        ),
      ).toThrow(/plugin consent integrity changed/);
    }
  });

  it("checks configured plugin recovery without requiring an unconfigured companion", () => {
    expect(() =>
      assertCompanionPluginRecords(
        (records, paths) => {
          records.matrix = {
            ...records.whatsapp!,
            clawhubPackage: "@openclaw/matrix",
            spec: "clawhub:@openclaw/matrix@2026.8.1",
          };
          writeJson(join(paths.whatsapp, "package.json"), {
            name: "@openclaw/matrix",
            version: "2026.8.1",
          });
          delete records.whatsapp;
          const bravePath = join(paths.codex, "..", "brave-plugin");
          mkdirSync(bravePath, { recursive: true });
          writeJson(join(bravePath, "package.json"), {
            name: "@openclaw/brave-plugin",
            version: "2026.8.1",
          });
          records.brave = {
            ...records.codex!,
            installPath: bravePath,
            resolvedName: "@openclaw/brave-plugin",
            spec: "@openclaw/brave-plugin@2026.8.1",
          };
        },
        true,
        ["discord", "matrix", "brave"],
      ),
    ).not.toThrow();
  });

  it("accepts frozen companion installs when the candidate lacks capability consent", () => {
    expect(() => assertCompanionPluginRecords(undefined, false)).not.toThrow();
  });

  it("requires artifact integrity when the candidate lacks capability consent", () => {
    expect(() =>
      assertCompanionPluginRecords((records) => {
        const discord = records.discord;
        if (!discord) {
          throw new Error("discord fixture missing");
        }
        Reflect.deleteProperty(discord, "integrity");
      }, false),
    ).toThrow(/discord plugin integrity missing/);
  });

  it.each([
    ["npm", "discord", "resolvedVersion", "version"],
    ["ClawHub", "whatsapp", "version", "resolvedVersion"],
  ] as const)(
    "requires the source-native version field for %s companion installs",
    (_sourceLabel, pluginId, requiredField, alternateField) => {
      expect(() =>
        assertCompanionPluginRecords((records) => {
          const record = records[pluginId];
          if (!record) {
            throw new Error(`${pluginId} fixture missing`);
          }
          record[alternateField] = record[requiredField];
          Reflect.deleteProperty(record, requiredField);
        }),
      ).toThrow(new RegExp(`${pluginId} plugin version changed`));
    },
  );

  it("requires the installed package version to match the companion record", () => {
    expect(() =>
      assertCompanionPluginRecords((_records, installPaths) => {
        writeJson(join(installPaths.discord, "package.json"), {
          name: "@openclaw/discord",
          version: "2026.8.0",
        });
      }),
    ).toThrow(/discord installed package version changed/);
  });

  it.each(["versioned-runtime-deps"])(
    "requires intact shared runtime cache contents for %s",
    (scenario) => {
      expect(() => runSessionStateAssertion(writeMigratedSessionState, { scenario })).not.toThrow();
      for (const mutation of ["remove", "corrupt"]) {
        expect(() =>
          runSessionStateAssertion(
            (stateDir) => {
              writeMigratedSessionState(stateDir);
              const root =
                scenario === "base"
                  ? join("discord", ".openclaw-runtime-deps-copy-stale")
                  : "openclaw-2026.6.1-feishu";
              const sentinel = join(
                stateDir,
                "plugin-runtime-deps",
                root,
                "node_modules",
                "stale-sentinel",
                "package.json",
              );
              if (mutation === "remove") {
                rmSync(sentinel);
              } else {
                writeJson(sentinel, { name: "stale-sentinel", version: "changed" });
              }
            },
            { scenario },
          ),
        ).toThrow(/stale-sentinel/);
      }
    },
  );

  it.each([false])(
    "artifact-only base/manual rejects retired global sources without a missing-path seed (recreated=%s)",
    (recreated) => {
      const verify = () =>
        runSessionStateAssertion((stateDir) => {
          const env = seedSessionSourceFixture(stateDir);
          writeMigratedSessionState(stateDir);
          if (recreated) {
            mkdirSync(join(stateDir, "sessions"), { recursive: true });
            writeJson(join(stateDir, "sessions", "sessions.json"), {});
          }
          return env;
        });
      if (recreated) {
        expect(verify).toThrow(/legacy sessions.json survived migration/);
      } else {
        expect(verify).not.toThrow();
      }
    },
  );

  it("prefers session_nodes over stale file and cache session stores", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
        writeLegacyCacheSessionState(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("does not mask missing session_nodes rows with a valid file store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        const db = new DatabaseSync(
          join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        );
        try {
          db.exec("DELETE FROM session_nodes;");
        } finally {
          db.close();
        }
        writeMigratedSessionFiles(stateDir);
      }),
    ).toThrow(/main legacy session row missing/);
  });

  it("does not mask empty legacy cache_entries with a valid file store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacyCacheSessionState(stateDir, { empty: true, replaceNodes: true });
        writeMigratedSessionFiles(stateDir);
      }),
    ).toThrow(/main legacy session row missing/);
  });

  it("prefers legacy cache_entries over a stale file session store", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacyCacheSessionState(stateDir, { replaceNodes: true });
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("prefers legacy session_entries over stale file and cache session stores", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        writeLegacySessionEntriesState(stateDir);
        writeLegacyCacheSessionState(stateDir, { includePrompt: false });
        writeMigratedSessionFiles(stateDir, { includePrompt: false });
      }),
    ).not.toThrow();
  });

  it("uses the file session store when SQLite has no supported session table", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        const agentDbDir = join(stateDir, "agents", "main", "agent");
        mkdirSync(agentDbDir, { recursive: true });
        const db = new DatabaseSync(join(agentDbDir, "openclaw-agent.sqlite"));
        try {
          db.exec("CREATE TABLE unrelated_state (key TEXT PRIMARY KEY);");
        } finally {
          db.close();
        }
        writeMigratedSessionFiles(stateDir);
      }),
    ).not.toThrow();
  });

  it.each(["queued", "cli-failed", "wrong-reply"])(
    "requires a completed persisted managed serving reply (%s)",
    (outcome) => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-survivor-serving-turn-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "openclaw"),
          `#!${testNodeExecPath}
const fs = require("node:fs");
const method = process.argv[4];
const params = JSON.parse(process.argv[process.argv.indexOf("--params") + 1]);
const outcome = process.env.PROBE_OUTCOME;
if (outcome === "cli-failed") {
  process.stderr.write(JSON.stringify(process.argv));
  process.exit(47);
}
let result;
if (method === "chat.send") {
  fs.writeFileSync(process.env.PROBE_MARKER_FILE, params.message.match(/OPENCLAW_E2E_SURVIVOR_[A-F0-9]+/)[0]);
  result = { status: outcome === "not-started" ? "error" : "started", runId: "serving-run" };
} else if (method === "agent.wait") {
  const pending = ["queued", "wait-timeout"].includes(outcome) && !fs.existsSync(process.env.PROBE_MARKER_FILE + ".waited");
  fs.writeFileSync(process.env.PROBE_MARKER_FILE + ".waited", "waited");
  result = { runId: params.runId, status: pending ? (outcome === "wait-timeout" ? "timeout" : "pending") : outcome === "turn-failed" ? "error" : "ok", ...(pending ? {} : { endedAt: 1788820180863 }) };
} else if (method === "chat.history") {
  result = { sessionId: outcome === "wrong-session" ? "replacement" : "upgrade-main-session", messages: [{
    role: outcome === "user-only" ? "user" : "assistant",
    content: [{ type: "text", text: outcome === "wrong-reply" ? "other" : fs.readFileSync(process.env.PROBE_MARKER_FILE, "utf8") }],
  }] };
} else { process.exit(47); }
process.stdout.write(JSON.stringify(result));
`,
          { mode: 0o755 },
        );
        const receipt = join(root, "receipt.json");
        let oracle = ASSERTIONS_PATH;
        if (outcome === "frozen-regular") {
          const selection = selectFrozenUpgradeOracle(root, "2026.9.3");
          expect(selection.result.status, selection.result.stderr).toBe(0);
          oracle = selection.oracle!;
        }
        const result = spawnSync(
          testNodeExecPath,
          [oracle, "assert-restart-serving-turn", receipt],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH}`,
              GATEWAY_AUTH_TOKEN_REF: "synthetic-serving-token",
              PROBE_OUTCOME: outcome,
              PROBE_MARKER_FILE: join(root, "marker"),
            },
          },
        );
        const succeeded = ["ok", "frozen-regular", "queued", "wait-timeout"].includes(outcome);
        expect(result.status, result.stderr).toBe(succeeded ? 0 : 1);
        expect(existsSync(receipt)).toBe(succeeded);
        expect(result.stderr).not.toContain("synthetic-serving-token");
        if (outcome === "cli-failed") {
          expect(result.stderr).toContain("chat.send managed serving probe failed (status 47)");
        }
        if (succeeded) {
          const proof = JSON.parse(readFileSync(receipt, "utf8"));
          expect(proof.sessionId).toBe("upgrade-main-session");
          expect(proof.reply.content[0].text).toBe(proof.marker);
          expect(proof.completion.status).toBe("ok");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { stage: "survival", mutation: "none", error: /metadata prompt was not preserved/ },
    { stage: "post-inference", mutation: "none", error: undefined },
  ])(
    "checks migrated session state after inference ($stage, $mutation)",
    ({ stage, mutation, error }) => {
      const check = () =>
        runSessionStateAssertion((stateDir) => {
          writeMigratedSessionState(stateDir);
          const db = new DatabaseSync(
            join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          );
          try {
            db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
              JSON.stringify({
                skillsSnapshot: {
                  prompt:
                    mutation === "stale-prompt"
                      ? "legacy prompt survives as metadata"
                      : "Current runtime skill instructions",
                  skills: mutation === "malformed-skills" ? null : [{ name: "survivor-skill" }],
                  ...(mutation === "missing-marker"
                    ? {}
                    : { promptFormatVersion: mutation === "invalid-marker" ? 0 : 4 }),
                  ...(mutation === "heavy-cache" ? { resolvedSkills: [] } : {}),
                },
              }),
              "agent:main:main",
            );
            if (mutation === "missing-session") {
              db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run("agent:main:main");
            }
            if (mutation === "missing-transcript") {
              db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(
                "upgrade-main-session",
              );
            }
          } finally {
            db.close();
          }
          return { OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage };
        });
      if (error) {
        expect(check).toThrow(error);
      } else {
        expect(check).not.toThrow();
      }
    },
  );

  it("rejects retired sessionFile metadata in SQLite-backed session rows", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        const db = new DatabaseSync(
          join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        );
        try {
          db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              sessionFile: join(stateDir, "sessions", "upgrade-main-session.jsonl"),
            }),
            "agent:main:main",
          );
        } finally {
          db.close();
        }
      }),
    ).toThrow(/retained retired sessionFile metadata/);
  });

  it("rejects ClawHub npm-pack installs outside the managed extensions root", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-survivor-outside-"));
    try {
      expect(() =>
        assertConfiguredPluginState({ installPath: join(root, "outside-matrix") }),
      ).toThrow(/managed extensions root/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
