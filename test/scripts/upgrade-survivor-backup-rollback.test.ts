import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const helper = resolve("scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs");
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

// A subprocess fixture owns only the published CLI boundary. The observer runs
// unmodified against real SQLite files; Docker supplies the actual release CLI.
const baselineProgram = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const controls = JSON.parse(fs.readFileSync(new URL("../controls.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(controls.events, JSON.stringify({ args, state: process.env.OPENCLAW_STATE_DIR, config: process.env.OPENCLAW_CONFIG_PATH }) + "\n");
const archiveRoot = "synthetic-backup";
const stateAsset = archiveRoot + "/payload/operator-state";
let result;
if (args[0] === "backup" && args[1] === "create") {
  const archive = args[4];
  assert.deepEqual(args, ["backup", "create", "--verify", "--output", archive, "--json"]);
  assert.equal(process.env.OPENCLAW_STATE_DIR, controls.source);
  const snapshot = path.join(path.dirname(archive), "snapshot");
  fs.cpSync(controls.source, snapshot, { recursive: true });
  fs.writeFileSync(archive, JSON.stringify({ snapshot }));
  result = { verified: true, dryRun: false, archivePath: archive, archiveRoot,
    assets: [{ kind: "state", sourcePath: controls.source, archivePath: controls.mode === "path-escape" ? "../outside" : stateAsset }] };
} else if (args[0] === "backup" && args[1] === "restore") {
  const archive = args[2];
  const target = args[4];
  assert.deepEqual(args, ["backup", "restore", archive, "--target", target, "--json"]);
  assert.notEqual(process.env.OPENCLAW_STATE_DIR, controls.source);
  assert(!fs.existsSync(process.env.OPENCLAW_STATE_DIR));
  const state = path.join(target, stateAsset);
  fs.cpSync(JSON.parse(fs.readFileSync(archive, "utf8")).snapshot, state, { recursive: true });
  const db = new DatabaseSync(path.join(state, controls.agentRelative));
  if (controls.mode === "missing-event") db.exec("DELETE FROM transcript_events WHERE seq = 2");
  if (controls.mode === "changed-session") db.exec("UPDATE session_nodes SET current_session_id = 'different-session'");
  if (controls.mode === "changed-payload") db.exec("UPDATE transcript_events SET event_json = '{}' WHERE seq = 1");
  if (controls.mode === "changed-schema") db.exec("PRAGMA user_version = 21");
  if (controls.mode === "changed-schema-meta") db.exec("UPDATE schema_meta SET schema_version = 21");
  db.close();
  if (controls.mode === "missing-legacy") fs.unlinkSync(path.join(state, controls.legacyRelative));
  result = { ok: true, archivePath: archive, targetPath: target, archiveRoot };
} else if (args[0] === "database") {
  const database = args[2];
  assert.deepEqual(args, ["database", "preflight-agent", database, "--agent-id", "main", "--json"]);
  assert.notEqual(process.env.OPENCLAW_STATE_DIR, controls.source);
  assert(!database.startsWith(controls.source + path.sep));
  const db = new DatabaseSync(database);
  const foundVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (controls.mode === "mutating-preflight") db.exec("DELETE FROM session_nodes");
  db.close();
  result = { schema: "openclaw.agent-schema-preflight.v1", databasePath: database, agentId: "main", status: "exact",
    foundVersion, targetVersion: controls.mode === "wrong-preflight" ? 21 : 19, requiresWrite: false, issues: [] };
} else {
  const database = args[2];
  assert.deepEqual(args, ["sessions", "--store", database, "--agent", "main", "--limit", "all", "--json"]);
  assert.notEqual(process.env.OPENCLAW_STATE_DIR, controls.source);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), {
    agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
  });
  if (controls.mode === "consumer-failure") process.exit(1);
  const db = new DatabaseSync(database);
  const sessions = db.prepare("SELECT session_key AS key, current_session_id AS sessionId FROM session_nodes ORDER BY session_key").all();
  if (controls.mode === "missing-consumer-session") sessions.pop();
  if (controls.mode === "wrong-consumer-key") sessions[0].key = "agent:main:wrong";
  if (controls.mode === "wrong-consumer-session") sessions[0].sessionId = "wrong-session";
  if (controls.mode === "mutating-consumer") db.exec("DELETE FROM transcript_events");
  db.close();
  result = { path: controls.mode === "wrong-consumer-path" ? controls.source : database,
    count: sessions.length, totalCount: sessions.length, limitApplied: null, hasMore: false, sessions };
}
process.stdout.write(JSON.stringify(result));
`;

function fixture() {
  const root = tempDirs.make("survivor-backup-rollback-");
  const state = join(root, "source");
  const runtimeRoot = join(root, "runtime");
  const packageRoot = join(runtimeRoot, "baseline-prefix", "lib", "node_modules", "openclaw");
  const entry = join(packageRoot, "dist", "index.mjs");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(artifactRoot);
  const agentRelative = "agents/main/agent/openclaw-agent.sqlite";
  const legacyRelative = "agents/ops/sessions/sessions.json";
  mkdirSync(dirname(join(state, agentRelative)), { recursive: true });
  mkdirSync(dirname(join(state, legacyRelative)), { recursive: true });
  mkdirSync(join(state, "state"));
  writeJson(join(state, legacyRelative), { "agent:ops:main": { sessionId: "legacy-session" } });
  const agent = new DatabaseSync(join(state, agentRelative));
  agent.exec(`
    PRAGMA user_version = 19;
    CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT);
    INSERT INTO schema_meta VALUES ('primary', 'agent', 19, 'main');
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT);
    INSERT INTO session_nodes VALUES ('agent:main:main', 'session-one', '{"sessionId":"session-one","label":"original"}');
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY(session_id, seq));
    INSERT INTO transcript_events VALUES ('session-one', 1, '{"id":"user-one","text":"hello"}');
    INSERT INTO transcript_events VALUES ('session-one', 2, '{"id":"assistant-one","text":"hello back"}');
  `);
  agent.close();
  const shared = new DatabaseSync(join(state, "state", "openclaw.sqlite"));
  shared.exec("PRAGMA user_version = 16");
  shared.close();
  writeJson(join(packageRoot, "package.json"), {
    name: "openclaw",
    version: "2026.9.4",
    openclaw: { schemaVersions: { agent: 19, state: 16 } },
  });
  writeFileSync(entry, baselineProgram);
  const events = join(root, "events.jsonl");
  const controlsFile = join(packageRoot, "controls.json");
  const controls = { source: state, agentRelative, legacyRelative, events };
  writeJson(controlsFile, controls);
  const beforeFile = join(artifactRoot, "schema-before.json");
  const afterFile = join(artifactRoot, "schema-after.json");
  const resultFile = join(artifactRoot, "backup-rollback.json");
  const schema = {
    baselineVersion: "2026.9.4",
    candidateVersion: "2026.9.5",
    stateDir: state,
    candidateSchemaVersions: { agent: 21, state: 17 },
    databases: [
      { kind: "state", relative: "state/openclaw.sqlite", userVersion: 16, contentVersion: 16 },
      { kind: "agent", relative: agentRelative, userVersion: 19, contentVersion: 19 },
    ],
    agents: [
      { agentId: "main", databaseRelative: agentRelative, files: [] },
      {
        agentId: "ops",
        databaseRelative: "agents/ops/agent/openclaw-agent.sqlite",
        files: [
          {
            kind: "legacy-store",
            relative: legacyRelative,
            sha256: createHash("sha256")
              .update(readFileSync(join(state, legacyRelative)))
              .digest("hex"),
          },
        ],
      },
    ],
  };
  writeJson(beforeFile, schema);
  writeJson(afterFile, {
    ...schema,
    databases: schema.databases.map((database) =>
      Object.assign({}, database, {
        userVersion: database.kind === "agent" ? 21 : 17,
        contentVersion: database.kind === "agent" ? 21 : 17,
      }),
    ),
  });
  const run = (...args: string[]) =>
    spawnSync(node, [helper, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: state },
    });
  return {
    root,
    state,
    packageRoot,
    entry,
    runtimeRoot,
    resultFile,
    afterFile,
    events,
    mode: (mode: string) => writeJson(controlsFile, { ...controls, mode }),
    capture: () => run("capture", beforeFile, packageRoot, entry, runtimeRoot, resultFile),
    verify: () => run("verify", resultFile, afterFile),
    run,
  };
}

describe("published backup rollback proof", () => {
  it("compares exact restored history and asks the retained runtime to inspect its own schema", () => {
    const f = fixture();
    const capture = f.capture();
    expect(capture.status, capture.stderr).toBe(0);
    const before = readJson(f.resultFile);
    expect(before.status).toBe("captured");
    const restored = f.verify();
    expect(restored.status, restored.stderr).toBe(0);
    const proof = readJson(f.resultFile);
    expect(proof).toMatchObject({
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      preflights: [{ agentId: "main", status: "exact", foundVersion: 19, targetVersion: 19 }],
      sessionReads: [{ agentId: "main", count: 1 }],
    });
    expect(proof.restoredStateDir).toContain(join("synthetic-backup", "payload", "operator-state"));
    expect(proof.before).toEqual(before.before);
    expect(proof.before.databases).toContainEqual({
      kind: "agent",
      relative: "agents/ops/agent/openclaw-agent.sqlite",
      agentId: "ops",
      present: false,
    });
    const commands = readFileSync(f.events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["backup", "create"],
      ["backup", "restore"],
      ["database", "preflight-agent"],
      ["sessions", "--store"],
    ]);
    expect(commands[0].state).toBe(f.state);
    expect(commands[1].state).toBe(commands[2].state);
    expect(commands[2].state).toBe(commands[3].state);
    expect(commands[1].state).not.toBe(f.state);
    const source = new DatabaseSync(join(f.state, "agents/main/agent/openclaw-agent.sqlite"), {
      readOnly: true,
    });
    try {
      expect(source.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
      expect(source.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()?.count).toBe(
        2,
      );
    } finally {
      source.close();
    }
  });

  it.each([
    ["missing-event", "restored baseline inventory differs"],
    ["changed-session", "restored baseline inventory differs"],
    ["changed-payload", "restored baseline inventory differs"],
    ["changed-schema", "restored baseline inventory differs"],
    ["changed-schema-meta", "restored baseline inventory differs"],
    ["missing-legacy", "ENOENT"],
    ["wrong-preflight", "preflight ran with the wrong baseline target"],
    ["mutating-preflight", "baseline preflight mutated restored history"],
    ["missing-consumer-session", "baseline session consumer lost sessions"],
    ["wrong-consumer-key", "baseline session consumer returned different identities"],
    ["wrong-consumer-session", "baseline session consumer returned different identities"],
    ["wrong-consumer-path", "baseline session consumer read the wrong store"],
    ["mutating-consumer", "baseline session consumer mutated restored history"],
    ["consumer-failure", "baseline sessions --store failed"],
  ])("rejects %s instead of reporting a successful rollback", (mode, message) => {
    const f = fixture();
    const capture = f.capture();
    expect(capture.status, capture.stderr).toBe(0);
    f.mode(mode);
    const result = f.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readJson(f.resultFile).status).not.toBe("passed");
  });

  it.each(["archive", "runtime", "candidate-evidence"])(
    "rejects changed %s before invoking restore",
    (changed) => {
      const f = fixture();
      const capture = f.capture();
      expect(capture.status, capture.stderr).toBe(0);
      if (changed === "archive") {
        writeFileSync(readJson(f.resultFile).archive.path, "replacement");
      }
      if (changed === "runtime") {
        writeFileSync(f.entry, "throw new Error('wrong runtime');");
      }
      if (changed === "candidate-evidence") {
        writeJson(f.afterFile, { ...readJson(f.afterFile), databases: [] });
      }
      const result = f.verify();
      expect(result.status).toBe(1);
      expect(readFileSync(f.events, "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it("rejects an escaping state asset during capture", () => {
    const f = fixture();
    f.mode("path-escape");
    const result = f.capture();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inventory path escaped its root");
  });

  it.each(["2026.9.3", "2026.9.4-beta.1"])(
    "records %s as not applicable without launching a baseline runtime",
    (version) => {
      const f = fixture();
      const result = f.run("eligibility", version, f.resultFile);
      expect(result.status, result.stderr).toBe(0);
      expect(readJson(f.resultFile)).toMatchObject({
        status: "not-applicable",
        baselineVersion: version,
      });
      expect(f.verify().status).toBe(0);
      expect(existsSync(f.events)).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")("survivor rollback ordering", () => {
  it.each([false, true])(
    "runs rollback after candidate proof and propagates rollback failure=%s",
    (fail) => {
      const root = tempDirs.make("survivor-rollback-order-");
      const prelude = join(root, "bash-env");
      // Keep the real runner's phase ordering, traps and summary. No package,
      // Gateway, registry or model work is needed to test the failure boundary.
      writeFileSync(
        prelude,
        `install_fixture_phases() {
  trap - DEBUG
  phase() {
    CURRENT_PHASE="$1"
    printf '%s\\n' "$CURRENT_PHASE" >>"$HOME/events"
    case "$CURRENT_PHASE" in
      install-baseline) baseline_version="2026.9.4" ;;
      update-candidate) candidate_version="2026.9.5"; installed_version="2026.9.5" ;;
      verify-backup-rollback)
        if [ "$FIXTURE_FAIL" = "1" ]; then return 43; fi
        printf '{"status":"passed","baselineVersion":"2026.9.4"}\\n' >"$ARTIFACT_ROOT/backup-rollback.json"
        ;;
    esac
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
      );
      const summaryFile = join(root, "artifacts", "summary.json");
      const result = spawnSync("bash", [runner], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${dirname(node)}:/usr/bin:/bin`,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: join(root, "state"),
          OPENCLAW_CONFIG_PATH: join(root, "state", "openclaw.json"),
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(root, "runtime"),
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summaryFile,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.9.4",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
          BASH_ENV: prelude,
          FIXTURE_FAIL: fail ? "1" : "0",
        },
      });
      const phases = readFileSync(join(root, "events"), "utf8").trim().split("\n");
      expect(phases.indexOf("capture-backup-rollback")).toBeGreaterThan(
        phases.indexOf("seed-legacy-operator-gateway"),
      );
      expect(phases.indexOf("capture-backup-rollback")).toBeLessThan(
        phases.indexOf("seed-formerly-bundled-plugin"),
      );
      expect(phases.indexOf("capture-backup-rollback")).toBeLessThan(
        phases.indexOf("update-candidate"),
      );
      expect(phases.indexOf("assert-candidate-schemas")).toBeLessThan(
        phases.indexOf("verify-backup-rollback"),
      );
      expect(phases.indexOf("legacy-operator-doctor-clean")).toBeLessThan(
        phases.indexOf("verify-backup-rollback"),
      );
      expect(phases.at(-1)).toBe("verify-backup-rollback");
      expect(result.status, result.stderr).toBe(fail ? 43 : 0);
      expect(readJson(summaryFile)).toMatchObject({
        status: fail ? "failed" : "passed",
        installedVersion: "2026.9.5",
        ...(fail
          ? { failure: { phase: "verify-backup-rollback" } }
          : { backupRollback: { status: "passed" } }),
      });
    },
  );
});
