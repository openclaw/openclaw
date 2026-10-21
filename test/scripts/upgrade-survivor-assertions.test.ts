import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { UPGRADE_SURVIVOR_ASSERTION_SCENARIOS } from "../../scripts/lib/upgrade-survivor-policy.mjs";
import { readLegacySessionStoreEntries } from "../../src/config/sessions/legacy-store-inspection.js";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import type { PluginUpdateOutcome } from "../../src/plugins/update.js";
import { withEnv } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  writePluginInspectFixture,
  type PluginInspectFixture,
} from "./plugin-inspect.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
// Extracted and sourced snippets do not execute the production Darwin Bash fallback.
const testBashExecPath = process.platform === "darwin" ? "/bin/bash" : "bash";

const ASSERTIONS_PATH = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

function runAssertion(command: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(testNodeExecPath, [ASSERTIONS_PATH, command, ...args], {
    encoding: "utf8",
    env: env && { ...process.env, ...env },
  });
}

function assertCommand(command: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return execFileSync(testNodeExecPath, [ASSERTIONS_PATH, command, ...args], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
}

function stateFixture(scenario = "base") {
  const root = tempDirs.make("openclaw-upgrade-survivor-");
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_WORKSPACE_DIR: workspace,
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
  };
  return { root, stateDir, workspace, env };
}

function seedStateScaffolding(stateDir: string, workspace: string, versioned = false) {
  mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "IDENTITY.md"), "# survivor\n");
  writeJson(join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
    id: "legacy-session",
  });
  writeSharedRuntimeCaches(stateDir, versioned);
}

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

const coreSteps = () =>
  ["global update", "global install swap", "openclaw doctor"].map((name) => ({
    name,
    exitCode: 0,
  }));
const consentWarning = (pluginId: string) => {
  const reason = `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
  return { reason, message: reason };
};

function expectCoreSteps(steps: Record<string, unknown>[], succeeds: boolean) {
  const report = {
    status: "ok",
    after: { version: "2026.10.3" },
    steps,
    postUpdate: { plugins: { status: "ok", sync: { errors: [] }, npm: { outcomes: [] } } },
  };
  const result = runJsonAssertion("assert-successful-update-json", report, "2026.10.3");
  expect(result.status, result.stderr).toBe(succeeds ? 0 : 1);
  if (!succeeds) {
    expect(result.stderr).toContain("successful update contained a failed core step");
  }
}

const RECOVERABLE_UPDATE = {
  status: "error",
  mode: "npm",
  reason: "post-update-plugins",
  before: { version: "2026.7.1-2" },
  after: { version: "2026.8.1" },
  steps: coreSteps(),
  postUpdate: {
    plugins: {
      status: "error",
      changed: false,
      reason: "post-plugin-doctor-invalid-config",
      warnings: [
        consentWarning("discord"),
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
  const root = tempDirs.make("openclaw-upgrade-json-");
  const file = join(root, "result.json");
  writeFileSync(file, contents);
  const result = runAssertion(command, [
    file,
    ...args,
    ...(command === "assert-recoverable-update-json" ? ["", "2026.7.1-2"] : []),
  ]);
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

function editAgentDb(stateDir: string, edit: (db: DatabaseSync) => void): undefined {
  using db = new DatabaseSync(join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"));
  edit(db);
}

function missingCodexUpdateResult() {
  const messages = [
    "@openclaw/codex unavailable; using clawhub:@openclaw/codex instead.",
    'Failed to install missing configured plugin "codex" from clawhub:@openclaw/codex: Package not found on ClawHub.',
  ];
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
    steps: coreSteps(),
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
  it.each<{
    name: string;
    patch?: Record<string, unknown>;
    omitStartup?: boolean;
    startupExitCode?: number;
    succeeds: boolean;
  }>([
    { name: "completed startup with cleanup advisory", succeeds: true },
    { name: "missing advisory", patch: { advisory: undefined }, succeeds: false },
    { name: "wrong advisory", patch: { advisory: { kind: "other" } }, succeeds: false },
    { name: "another cleanup step", patch: { name: "candidate-doctor-cleanup" }, succeeds: false },
    { name: "cleanup execution failure", patch: { exitCode: 13 }, succeeds: false },
    { name: "cleanup timeout", patch: { termination: "timeout" }, succeeds: false },
    { name: "cleanup signal", patch: { signal: "SIGTERM" }, succeeds: false },
    { name: "killed cleanup", patch: { killed: true }, succeeds: false },
    { name: "truncated cleanup output", patch: { outputLimitExceeded: true }, succeeds: false },
    {
      name: "cleanup failure facts",
      patch: { failureFacts: [{ code: "cleanup-failed" }] },
      succeeds: false,
    },
    { name: "missing primary startup", omitStartup: true, succeeds: false },
    { name: "failed primary startup", startupExitCode: 1, succeeds: false },
  ])(
    "classifies $name without hiding failed core steps",
    ({ patch, omitStartup, startupExitCode = 0, succeeds }) => {
      expectCoreSteps(
        [
          ...(omitStartup
            ? []
            : [{ name: "candidate-gateway-startup", exitCode: startupExitCode }]),
          {
            name: "candidate-gateway-startup-cleanup",
            exitCode: null,
            advisory: {
              kind: "recoverable-maintenance",
              message:
                "Update cleanup deadline elapsed before process close and termination requests both completed. Update validation results are unchanged.",
            },
            ...patch,
          },
        ],
        succeeds,
      );
    },
  );

  it.each([
    { name: "completed informational inspection", patch: {}, succeeds: true },
    { name: "warning", patch: { doctorLintFindings: [{ severity: "warning" }] }, succeeds: false },
    { name: "error", patch: { doctorLintFindings: [{ severity: "error" }] }, succeeds: false },
    { name: "missing findings", patch: { doctorLintFindings: undefined }, succeeds: false },
    { name: "empty findings", patch: { doctorLintFindings: [] }, succeeds: false },
    { name: "another step", patch: { name: "database migration" }, succeeds: false },
    { name: "unclassified failure", patch: { advisory: undefined }, succeeds: false },
    { name: "execution failure", patch: { exitCode: 13 }, succeeds: false },
    { name: "timeout", patch: { termination: "timeout" }, succeeds: false },
    { name: "signal", patch: { signal: "SIGTERM" }, succeeds: false },
    { name: "killed process", patch: { killed: true }, succeeds: false },
    { name: "truncated output", patch: { outputLimitExceeded: true }, succeeds: false },
    {
      name: "failure facts",
      patch: { failureFacts: [{ code: "inspection-failed" }] },
      succeeds: false,
    },
  ])(
    "classifies a post-activation $name without changing update success",
    ({ patch, succeeds }) => {
      expectCoreSteps(
        [
          { name: "global install swap", exitCode: 0 },
          {
            name: "post-activation doctor inspections",
            exitCode: 1,
            termination: "exit",
            signal: null,
            killed: false,
            outputLimitExceeded: false,
            advisory: {
              kind: "recoverable-maintenance",
              message: "Deferred Doctor inspections reported 1 advisory finding after restart.",
            },
            doctorLintFindings: [
              {
                checkId: "core/doctor/command-owner",
                severity: "info",
                message: "Owner guidance.",
              },
            ],
            ...patch,
          },
        ],
        succeeds,
      );
    },
  );

  it.each([false, true])("classifies missing Codex with consent failure=%s", (consentFailure) => {
    const report = missingCodexUpdateResult();
    if (consentFailure) {
      report.postUpdate.plugins.npm.outcomes = report.postUpdate.plugins.npm.outcomes.map(
        (outcome) =>
          outcome.pluginId === "codex" && outcome.status === "error"
            ? { ...outcome, code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" }
            : outcome,
      );
    }
    const result = withEnv(
      { OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-configured-plugin-migration" },
      () => runJsonAssertion("assert-successful-update-json", report, "2026.9.4"),
    );
    if (consentFailure) {
      expect(result.status).not.toBe(0);
    } else {
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("rejects missing-Codex history with reversed history", () => {
    const report = missingCodexUpdateResult();
    const outcomes = report.postUpdate.plugins.npm.outcomes;
    const transition = outcomes[2]!;
    outcomes.splice(2, 2, outcomes[3]!, transition);
    report.postUpdate.plugins.warnings[0]!.reason = transition.message;
    report.postUpdate.plugins.warnings[0]!.pluginId = transition.pluginId;
    const result = withEnv(
      { OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-configured-plugin-migration" },
      () => runJsonAssertion("assert-successful-update-json", report, "2026.9.4"),
    );
    expect(result.status).not.toBe(0);
  });

  it("accepts only a completed core swap stranded on capability consent", () => {
    expect(
      runPrefixedJsonAssertion("assert-recoverable-update-json", RECOVERABLE_UPDATE, "2026.8.1")
        .status,
    ).toBe(0);
    const consentError = consentWarning("discord").reason;
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
        { npm: { outcomes: [{ ...consentOutcome, pluginId: "unreviewed" }] } },
        { reason: "registry-timeout" },
      ].map((patch) => withPluginResult({ ...typedConsentResult.postUpdate.plugins, ...patch })),
      { ...RECOVERABLE_UPDATE, postUpdate: { plugins: { reason: "registry-timeout" } } },
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

type SessionLayout = {
  table?: "session_nodes" | "session_entries" | "cache_entries" | "unrelated_state";
  empty?: boolean;
  staleCache?: boolean;
  filePrompt?: boolean;
};

function writeMigratedSessionState(stateDir: string, layout: SessionLayout = {}): undefined {
  const agentSessionsDir = join(stateDir, "agents", "main", "sessions");
  const agentDbDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(agentSessionsDir, { recursive: true });
  mkdirSync(agentDbDir, { recursive: true });

  editAgentDb(stateDir, (db) => {
    const table = layout.table ?? "session_nodes";
    if (table === "unrelated_state") {
      db.exec("CREATE TABLE unrelated_state (key TEXT PRIMARY KEY);");
      return;
    }
    db.exec(`
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
    const cache = table === "cache_entries";
    const idColumn = table === "session_nodes" ? "current_session_id" : "session_id";
    db.exec(
      cache
        ? `
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
    `
        : `
      CREATE TABLE ${table} (
        session_key TEXT PRIMARY KEY,
        ${idColumn} TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
    );
    const insertSession = db.prepare(`
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertEntry = db.prepare(
      cache
        ? "INSERT INTO cache_entries VALUES (?, ?, ?)"
        : `
      INSERT INTO ${table} (session_key, ${idColumn}, entry_json, updated_at)
      VALUES (?, ?, ?, ?)
    `,
    );
    const insertTranscript = db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const [sessionKey, { sessionId, ...entry }] of Object.entries(
      createMigratedSessionFileStore(),
    )) {
      insertSession.run(sessionId, sessionKey, 1710000000000, 1710000000000);
      if (!layout.empty) {
        if (cache) {
          insertEntry.run("session_entries", sessionKey, JSON.stringify({ sessionId, ...entry }));
        } else {
          insertEntry.run(
            sessionKey,
            sessionId,
            JSON.stringify(table === "session_entries" ? { sessionId, ...entry } : entry),
            1710000000000,
          );
        }
      }
      insertTranscript.run(
        sessionId,
        1,
        JSON.stringify({ type: "session", id: sessionId }),
        1710000000000,
      );
    }
    if (layout.staleCache) {
      db.exec(
        "CREATE TABLE cache_entries (scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL)",
      );
      const insert = db.prepare("INSERT INTO cache_entries VALUES (?, ?, ?)");
      for (const [key, entry] of Object.entries(
        createMigratedSessionFileStore({ includePrompt: false }),
      )) {
        insert.run("session_entries", key, JSON.stringify(entry));
      }
    }
  });
  if (layout.filePrompt !== undefined) {
    writeMigratedSessionFiles(stateDir, { includePrompt: layout.filePrompt });
  }
}

function createMigratedSessionFileStore(
  options: { includePrompt?: boolean } = {},
): Record<string, { sessionId: string; [key: string]: unknown }> {
  const main: { sessionId: string; [key: string]: unknown } = { sessionId: "upgrade-main-session" };
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
  for (const { sessionId } of Object.values(createMigratedSessionFileStore(options))) {
    writeFileSync(
      join(agentSessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    );
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
  const { stateDir, workspace, env } = stateFixture(options.scenario);
  seedStateScaffolding(stateDir, workspace, options.scenario === "versioned-runtime-deps");
  const fixtureEnv = setup(stateDir);
  for (const command of options.commands ?? ["assert-state"]) {
    assertCommand(command, {
      ...fixtureEnv,
      ...env,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: "2026.6.1",
    });
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
  const { root, stateDir, workspace, env } = stateFixture("configured-plugin-installs");
  seedStateScaffolding(stateDir, workspace);
  const matrixInstallDir = params.installPath ?? join(stateDir, "extensions", "matrix");
  mkdirSync(join(stateDir, "plugins"), { recursive: true });
  mkdirSync(matrixInstallDir, { recursive: true });
  writeMigratedSessionState(stateDir);
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

  assertCommand("assert-state", {
    ...env,
    OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
  });
}

function assertConfig(params: {
  acceptedIntents: string[];
  baselineVersion?: string;
  config: unknown;
  scenario: string;
  stage?: "baseline" | "survival";
  updateChannel?: string;
}): void {
  const root = tempDirs.make("openclaw-upgrade-survivor-config-");

  const configPath = join(root, "openclaw.json");
  const coveragePath = join(root, "coverage.json");
  writeJson(configPath, params.config);
  writeJson(coveragePath, {
    acceptedIntents: params.acceptedIntents,
    baselineVersion: params.baselineVersion,
  });

  assertCommand("assert-config", {
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coveragePath,
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: params.scenario,
    OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: params.stage ?? "survival",
    OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL: params.updateChannel ?? "",
  });
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

function recordOfficialAcceptance(records: Record<string, PluginInstallRecord>) {
  Object.assign(records.discord!, {
    acceptedSurface: ACCEPTED_SURFACE,
    acceptedSurfaceHash: acceptedSurfaceHash(),
    acceptedSurfaceAt: "2026-08-27T00:00:00.000Z",
    acceptedSurfaceIntegrity: records.discord!.integrity,
  });
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
  const root = tempDirs.make("openclaw-upgrade-survivor-companions-");

  const stateDir = join(root, "state");
  const version = "2026.8.1";
  const npmPath = (id: string) =>
    join(stateDir, "npm", "projects", id, "node_modules", "@openclaw", id);
  const discordInstallPath = npmPath("discord");
  const codexInstallPath = npmPath("codex");
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
  const npmRecord = (id: string): PluginInstallRecord => ({
    source: "npm",
    spec: `@openclaw/${id}@${version}`,
    resolvedName: `@openclaw/${id}`,
    resolvedVersion: version,
    integrity: npmIntegrity,
    installPath: npmPath(id),
    ...(recoveryPluginIds
      ? {
          sourcePath: join(root, "unverified-plugin.tgz"),
          artifactKind: "npm-pack" as const,
          ...(capabilityConsentSupported ? consent(npmIntegrity) : {}),
        }
      : {}),
  });
  const records: Record<string, PluginInstallRecord> = {
    discord: npmRecord("discord"),
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
    codex: npmRecord("codex"),
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
          warnings: recoveryPluginIds.map(consentWarning),
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
}

describe("upgrade survivor assertions", () => {
  it.each([
    ["2026.8.35", true, "openclaw@2026.9.2", ""],
    ["2026.9.3", false, "openclaw@2026.8.35", "2026.8.35"],
  ])(
    "selects upgrade assertion ownership from immutable target %s",
    (version, selected, baseline, workingVersion) => {
      const root = tempDirs.make("openclaw-upgrade-oracle-");

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
        const trusted = "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor";
        expect([proof.trustedAssertions, proof.trustedDiagnostics]).toEqual([
          `${trusted}/assertions.mjs`,
          `${trusted}/diagnostics.mjs`,
        ]);
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
        cpSync("scripts/lib/release-version.mjs", join(runtimeScripts, "lib/release-version.mjs"));
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
              ...[
                "e2e/lib/plugins/npm-registry-server.mjs",
                "lib/npm-publish-plan.mjs",
                "lib/bounded-response.mjs",
                "e2e/lib/plugin-index-sqlite.mjs",
                "e2e/lib/env-limits.mjs",
                "e2e/lib/text-file-utils.mjs",
              ].flatMap((path) => [
                "-v",
                expect.stringMatching(
                  new RegExp(
                    `${path.split("/").at(-1)!.replaceAll(".", "\\.")}:/app/scripts/${path.replaceAll(".", "\\.")}:ro$`,
                    "u",
                  ),
                ),
              ]),
            ]
          : [],
      );
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
      const root = tempDirs.make("openclaw-upgrade-baseline-sdk-");

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
    const scenarios = JSON.parse(assertCommand("list-scenarios", {}).toString()) as string[];

    expect(scenarios).toContain("base");
    expect(scenarios).toContain("codex-allowlist-survival");
    expect(scenarios).toContain("mobile-pairing-reconnect");
    expect(scenarios).toContain("acpx-openclaw-tools-bridge");
    expect(scenarios).toContain("prerelease-plugin-registry");
    expect(scenarios).toContain("sqlite-volume");
    expect(scenarios).toEqual(UPGRADE_SURVIVOR_ASSERTION_SCENARIOS);
    expect(new Set(scenarios).size).toBe(scenarios.length);
  });

  it("validates Tool Search at baseline 2026.9.7 and after upgrade", () => {
    const run = (toolSearch: unknown, stage: "baseline" | "survival" = "survival") =>
      assertConfig({
        acceptedIntents: ["tool-search"],
        baselineVersion: "2026.9.7",
        config: { tools: { toolSearch } },
        scenario: "base",
        stage,
      });
    expect(() => run({ mode: "tools" }, "baseline")).not.toThrow();
    expect(() => run({ mode: "code", codeTimeoutMs: 5000 }, "baseline")).toThrow(
      /Tool Search mode/,
    );
    expect(() => run({ mode: "tools", codeTimeoutMs: 5000 }, "baseline")).toThrow(/legacy timeout/);
    expect(() => run({ mode: "tools" })).not.toThrow();
  });

  it("allows token rotation and requires each reconnect to use the newest stored token", () => {
    const root = tempDirs.make("openclaw-mobile-pairing-evidence-");
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
    const verify = () => assertCommand("assert-mobile-pairing-evidence", {}, files);
    const finalEvidenceFile = files[2];
    if (!finalEvidenceFile) {
      throw new Error("final mobile pairing evidence fixture missing");
    }

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
  });

  it.each(["base"])("seeds recent ordered session timestamps for %s", (scenario) => {
    const { stateDir, workspace, env } = stateFixture(scenario);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const beforeSeed = Date.now();
    assertCommand("seed", env);
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
    const [mainUpdatedAt, directUpdatedAt, groupUpdatedAt] = timestamps as [number, number, number];
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
  });

  it("requires every baseline cron SQLite specimen before update", () => {
    const fixture = stateFixture("cron-scheduled-authority");
    const { stateDir } = fixture;
    const env = {
      ...fixture.env,
      OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: "baseline",
    };
    const run = (command: string) => runAssertion(command, [], env);
    const seeded = runAssertion("seed", [], { ...env, OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base" });
    expect(seeded.status, seeded.stderr).toBe(0);
    mkdirSync(join(stateDir, "state"), { recursive: true });
    const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE cron_jobs(job_id TEXT PRIMARY KEY, job_json TEXT NOT NULL)");
    for (let index = 0; index < 5; index++) {
      db.prepare("INSERT INTO cron_jobs VALUES (?, ?)").run(`cron-${index}`, "{}");
    }
    const baseline = run("assert-state");
    expect(baseline.status, baseline.stderr).toBe(0);
    db.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run("cron-4");
    db.close();
    const missingRow = run("assert-state");
    expect(missingRow.status).not.toBe(0);
    expect(missingRow.stderr).toContain("baseline cron authority fixture row count changed");
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

  it.each([
    {
      name: "installed inspection without repository development dependencies",
      mutate: undefined,
      capabilityConsentSupported: true,
      options: { isolateAssertionRuntime: true },
    },
    {
      name: "recorded acceptance on verified official companions",
      mutate: recordOfficialAcceptance,
      capabilityConsentSupported: true,
      options: {},
    },
    {
      name: "frozen companions without capability consent support",
      mutate: undefined,
      capabilityConsentSupported: false,
      options: {},
    },
  ])("accepts $name", ({ mutate, capabilityConsentSupported, options }) => {
    expect(() =>
      assertCompanionPluginRecords(mutate, capabilityConsentSupported, undefined, options),
    ).not.toThrow();
  });

  it.each<
    [string, NonNullable<Parameters<typeof assertCompanionPluginRecords>[0]>, RegExp, boolean?]
  >([
    [
      "official consent without integrity",
      (records) => {
        recordOfficialAcceptance(records);
        Reflect.deleteProperty(records.discord!, "acceptedSurfaceIntegrity");
      },
      /discord plugin consent integrity/,
    ],
    [
      "partial official consent",
      (records) => Object.assign(records.discord!, { acceptedSurfaceHash: "partial" }),
      /discord plugin accepted surface missing/,
    ],
    [
      "custom ClawHub consent without integrity",
      (records) => Reflect.deleteProperty(records.whatsapp!, "acceptedSurfaceIntegrity"),
      /whatsapp plugin consent integrity/,
    ],
    [
      "custom ClawHub consent with a changed hash",
      (records) => Object.assign(records.whatsapp!, { acceptedSurfaceHash: "incorrect" }),
      /whatsapp plugin consent hash changed/,
    ],
    [
      "custom ClawHub consent without its surface",
      (records) => Reflect.deleteProperty(records.whatsapp!, "acceptedSurface"),
      /whatsapp plugin accepted surface missing/,
    ],
    [
      "unaccepted custom ClawHub record",
      (records) => {
        for (const field of [
          "acceptedSurface",
          "acceptedSurfaceHash",
          "acceptedSurfaceAt",
          "acceptedSurfaceIntegrity",
        ]) {
          Reflect.deleteProperty(records.whatsapp!, field);
        }
      },
      /whatsapp plugin accepted surface missing/,
    ],
    [
      "unverified npm record",
      (records) => Object.assign(records.discord!, { artifactKind: "npm-pack" }),
      /discord plugin accepted surface missing/,
    ],
    [
      "official-looking file spec",
      (records) => Object.assign(records.discord!, { spec: "@openclaw/discord@file:payload" }),
      /discord plugin accepted surface missing/,
    ],
    [
      "official-looking git resolvedSpec",
      (records) =>
        Object.assign(records.discord!, {
          resolvedSpec: "@openclaw/discord@git+https://example.invalid/discord.git",
        }),
      /discord plugin accepted surface missing/,
    ],
    [
      "missing integrity without capability consent support",
      (records) => Reflect.deleteProperty(records.discord!, "integrity"),
      /discord plugin integrity missing/,
      false,
    ],
    [
      "npm record without its source-native version",
      (records) => {
        records.discord!.version = records.discord!.resolvedVersion;
        Reflect.deleteProperty(records.discord!, "resolvedVersion");
      },
      /discord plugin version changed/,
    ],
    [
      "ClawHub record without its source-native version",
      (records) => {
        records.whatsapp!.resolvedVersion = records.whatsapp!.version;
        Reflect.deleteProperty(records.whatsapp!, "version");
      },
      /whatsapp plugin version changed/,
    ],
    [
      "installed package version differing from its record",
      (_records, installPaths) => {
        writeJson(join(installPaths.discord, "package.json"), {
          name: "@openclaw/discord",
          version: "2026.8.0",
        });
      },
      /discord installed package version changed/,
    ],
  ])("rejects %s", (_name, mutate, error, capabilityConsentSupported = true) => {
    expect(() => assertCompanionPluginRecords(mutate, capabilityConsentSupported)).toThrow(error);
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

  it("requires intact shared runtime cache contents for versioned-runtime-deps", () => {
    const scenario = "versioned-runtime-deps";
    expect(() => runSessionStateAssertion(writeMigratedSessionState, { scenario })).not.toThrow();
    for (const mutation of ["remove", "corrupt"]) {
      expect(() =>
        runSessionStateAssertion(
          (stateDir) => {
            writeMigratedSessionState(stateDir);
            const sentinel = join(
              stateDir,
              "plugin-runtime-deps",
              "openclaw-2026.6.1-feishu",
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
  });

  it("accepts artifact-only base/manual without retired global sources or a missing-path seed", () => {
    const verify = () =>
      runSessionStateAssertion((stateDir) => {
        const env = seedSessionSourceFixture(stateDir);
        writeMigratedSessionState(stateDir);
        return env;
      });
    expect(verify).not.toThrow();
  });

  it.each([false, true])("preserves frozen inline ACP metadata (shared database: %s)", (shared) => {
    runSessionStateAssertion(
      (stateDir) => {
        const env = seedSessionSourceFixture(stateDir, "acpx-openclaw-tools-bridge");
        const storePath = join(stateDir, "agents", "main", "sessions", "sessions.json");
        const legacy = JSON.parse(readFileSync(storePath, "utf8"));
        const store = createMigratedSessionFileStore();
        store["agent:main:slack:channel:cupgrade"] = {
          ...store["agent:main:slack:channel:cupgrade"],
          acp: legacy["agent:main:slack:channel:cupgrade"].acp,
        };
        writeMigratedSessionFiles(stateDir);
        writeJson(storePath, store);
        if (shared) {
          mkdirSync(join(stateDir, "state"), { recursive: true });
          const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
          db.close();
        }
        return env;
      },
      { scenario: "acpx-openclaw-tools-bridge" },
    );
  });

  it.each<{ name: string; layout: SessionLayout; error?: RegExp }>([
    {
      name: "session_nodes over stale file and cache stores",
      layout: { staleCache: true, filePrompt: false },
    },
    {
      name: "empty session_nodes over a valid file store",
      error: /main legacy session row missing/,
      layout: { empty: true, filePrompt: true },
    },
    {
      name: "empty cache_entries over a valid file store",
      error: /main legacy session row missing/,
      layout: { table: "cache_entries", empty: true, filePrompt: true },
    },
    {
      name: "cache_entries over a stale file store",
      layout: { table: "cache_entries", filePrompt: false },
    },
    {
      name: "session_entries over stale file and cache stores",
      layout: { table: "session_entries", staleCache: true, filePrompt: false },
    },
    {
      name: "file store when SQLite has no supported session table",
      layout: { table: "unrelated_state", filePrompt: true },
    },
  ])("uses the authoritative $name", ({ layout, error }) => {
    const check = () =>
      runSessionStateAssertion((stateDir) => writeMigratedSessionState(stateDir, layout));
    if (error) {
      expect(check).toThrow(error);
    } else {
      expect(check).not.toThrow();
    }
  });

  it.each(["queued", "cli-failed", "wrong-reply"])(
    "requires a completed persisted managed serving reply (%s)",
    (outcome) => {
      const root = tempDirs.make("openclaw-survivor-serving-turn-");

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
  result = { status: "started", runId: "serving-run" };
} else if (method === "agent.wait") {
  const pending = outcome === "queued" && !fs.existsSync(process.env.PROBE_MARKER_FILE + ".waited");
  fs.writeFileSync(process.env.PROBE_MARKER_FILE + ".waited", "waited");
  result = { runId: params.runId, status: pending ? "pending" : "ok", ...(pending ? {} : { endedAt: 1788820180863 }) };
} else if (method === "chat.history") {
  result = { sessionId: "upgrade-main-session", messages: [{
    role: "assistant",
    content: [{ type: "text", text: outcome === "wrong-reply" ? "other" : fs.readFileSync(process.env.PROBE_MARKER_FILE, "utf8") }],
  }] };
} else { process.exit(47); }
process.stdout.write(JSON.stringify(result));
`,
        { mode: 0o755 },
      );
      const receipt = join(root, "receipt.json");
      const result = runAssertion("assert-restart-serving-turn", [receipt], {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GATEWAY_AUTH_TOKEN_REF: "synthetic-serving-token",
        PROBE_OUTCOME: outcome,
        PROBE_MARKER_FILE: join(root, "marker"),
      });
      const succeeded = outcome === "queued";
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
    },
  );

  it.each([
    { stage: "survival", error: /metadata prompt was not preserved/ },
    { stage: "post-inference", error: undefined },
  ])("checks migrated session state after inference ($stage)", ({ stage, error }) => {
    const check = () =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        editAgentDb(stateDir, (db) => {
          db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              skillsSnapshot: {
                prompt: "Current runtime skill instructions",
                skills: [{ name: "survivor-skill" }],
                promptFormatVersion: 4,
              },
            }),
            "agent:main:main",
          );
        });
        return { OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage };
      });
    if (error) {
      expect(check).toThrow(error);
    } else {
      expect(check).not.toThrow();
    }
  });

  it("rejects retired sessionFile metadata in SQLite-backed session rows", () => {
    expect(() =>
      runSessionStateAssertion((stateDir) => {
        writeMigratedSessionState(stateDir);
        editAgentDb(stateDir, (db) => {
          db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
            JSON.stringify({
              sessionFile: join(stateDir, "sessions", "upgrade-main-session.jsonl"),
            }),
            "agent:main:main",
          );
        });
      }),
    ).toThrow(/retained retired sessionFile metadata/);
  });

  it("rejects ClawHub npm-pack installs outside the managed extensions root", () => {
    const root = tempDirs.make("openclaw-upgrade-survivor-outside-");

    expect(() =>
      assertConfiguredPluginState({ installPath: join(root, "outside-matrix") }),
    ).toThrow(/managed extensions root/);
  });
});
