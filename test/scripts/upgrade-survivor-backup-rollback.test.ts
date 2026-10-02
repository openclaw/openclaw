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
import { execFileSync } from "node:child_process";
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
  fs.mkdirSync(path.join(snapshot, stateAsset), { recursive: true });
  fs.cpSync(controls.source, path.join(snapshot, stateAsset), { recursive: true });
  if (controls.transcriptRelative && controls.mode !== "retained-transcript") {
    fs.unlinkSync(path.join(snapshot, stateAsset, controls.transcriptRelative));
  }
  if (controls.mode === "omit-unrelated") fs.unlinkSync(path.join(snapshot, stateAsset, "agents/main/sessions/unrelated.jsonl"));
  execFileSync("tar", ["-czf", archive, "-C", snapshot, archiveRoot]);
  result = { verified: true, dryRun: false, archivePath: archive, archiveRoot, skippedVolatileCount: controls.transcriptRelative && controls.mode !== "zero-omission" ? 1 : 0,
    assets: [{ kind: "state", sourcePath: controls.source, archivePath: controls.mode === "path-escape" ? "../outside" : stateAsset }] };
} else if (args[0] === "backup" && args[1] === "restore") {
  const archive = args[2];
  const target = args[4];
  assert.deepEqual(args, ["backup", "restore", archive, "--target", target, "--json"]);
  assert.notEqual(process.env.OPENCLAW_STATE_DIR, controls.source);
  assert(!fs.existsSync(process.env.OPENCLAW_STATE_DIR));
  const state = path.join(target, stateAsset);
  fs.mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", target]);
  if (controls.mode === "lost-transcript") fs.unlinkSync(path.join(state, controls.transcriptRelative));
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

function fixture(withTranscript = false) {
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
  const transcriptRelative = "agents/main/sessions/upgrade-restored-index-history.jsonl";
  if (withTranscript) {
    const history = [
      { type: "session", id: "upgrade-restored-index-history", version: 3 },
      {
        type: "message",
        id: "retained-event",
        message: { role: "user", content: "Retained restored-index history" },
      },
    ];
    mkdirSync(dirname(join(state, transcriptRelative)), { recursive: true });
    writeFileSync(
      join(state, transcriptRelative),
      history.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    history.forEach((event, seq) =>
      agent
        .prepare("INSERT INTO transcript_events VALUES (?, ?, ?)")
        .run("upgrade-restored-index-history", seq, JSON.stringify(event)),
    );
  }
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
  const controls = {
    source: state,
    agentRelative,
    legacyRelative,
    events,
    ...(withTranscript ? { transcriptRelative } : {}),
  };
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
  if (withTranscript) {
    const files = schema.agents[0]!.files as Array<{
      kind: string;
      relative: string;
      sha256: string;
    }>;
    files.push({
      kind: "transcript",
      relative: transcriptRelative,
      sha256: createHash("sha256")
        .update(readFileSync(join(state, transcriptRelative)))
        .digest("hex"),
    });
  }
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
    beforeFile,
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

  it("proves canonical history when published 9.4 omits the exact raw fixture transcript", () => {
    const f = fixture(true);
    const capture = f.capture();
    expect(capture.status, capture.stderr).toBe(0);
    const before = readJson(f.resultFile);
    const restored = f.verify();
    expect(restored.status, restored.stderr).toBe(0);
    expect(before.backupCreate.skippedVolatileCount).toBe(1);
    expect(before.omittedRawTranscripts).toMatchObject([
      {
        relative: "agents/main/sessions/upgrade-restored-index-history.jsonl",
        canonicalEventCount: 2,
        reason: "published-2026.9.4-volatile-transcript",
      },
    ]);
    const proof = readJson(f.resultFile);
    expect(proof.rawTranscriptRestoration).toBe("unsupported-by-published-backup");
    expect(proof.before).toEqual(before.before);
    expect(proof.sessionReads).toMatchObject([{ agentId: "main", count: 1 }]);
  });

  it.each([
    "zero-omission",
    "missing-history",
    "changed-history",
    "unqualified-path",
    "unqualified-kind",
    "unqualified-baseline",
  ])("refuses volatile omission without %s qualification", (mode) => {
    const f = fixture(true);
    if (mode === "zero-omission") {
      f.mode(mode);
    }
    if (mode === "missing-history" || mode === "changed-history") {
      const db = new DatabaseSync(join(f.state, "agents/main/agent/openclaw-agent.sqlite"));
      db.exec(
        mode === "missing-history"
          ? "DELETE FROM transcript_events WHERE session_id = 'upgrade-restored-index-history'"
          : "UPDATE transcript_events SET event_json = '{}' WHERE session_id = 'upgrade-restored-index-history' AND seq = 1",
      );
      db.close();
    }
    if (mode.startsWith("unqualified")) {
      const schema = readJson(f.beforeFile);
      if (mode === "unqualified-kind") {
        schema.agents[0].files[0].kind = "legacy-store";
      }
      if (mode === "unqualified-path") {
        const file = schema.agents[0].files[0];
        file.relative = "agents/main/sessions/unrelated.jsonl";
        writeFileSync(
          join(f.state, file.relative),
          readFileSync(join(f.state, "agents/main/sessions/upgrade-restored-index-history.jsonl")),
        );
        f.mode("omit-unrelated");
      }
      if (mode === "unqualified-baseline") {
        schema.baselineVersion = "2026.9.5";
        const manifest = readJson(join(f.packageRoot, "package.json"));
        writeJson(join(f.packageRoot, "package.json"), { ...manifest, version: "2026.9.5" });
      }
      writeJson(f.beforeFile, schema);
    }
    const result = f.capture();
    expect(result.status, result.stderr).toBe(1);
  });

  it("rejects a raw transcript lost during restore when it was present in the archive", () => {
    const f = fixture(true);
    f.mode("retained-transcript");
    const captured = f.capture();
    expect(captured.status, captured.stderr).toBe(0);
    expect(readJson(f.resultFile).omittedRawTranscripts).toEqual([]);
    f.mode("lost-transcript");
    const restored = f.verify();
    expect(restored.status).toBe(1);
    expect(restored.stderr).toContain("ENOENT");
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
  it.each([
    { baselineVersion: "2026.9.4", fail: false },
    { baselineVersion: "2026.9.4", fail: true },
    { baselineVersion: "2026.9.2", fail: false },
  ])(
    "runs $baselineVersion rollback after candidate proof and propagates rollback failure=$fail",
    ({ baselineVersion, fail }) => {
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
      install-baseline) baseline_version="$FIXTURE_BASELINE_VERSION" ;;
      update-candidate) candidate_version="2026.9.5"; installed_version="2026.9.5" ;;
      verify-backup-rollback)
        if [ "$FIXTURE_FAIL" = "1" ]; then return 43; fi
        printf '{"status":"passed","baselineVersion":"%s"}\\n' "$baseline_version" >"$ARTIFACT_ROOT/backup-rollback.json"
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
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${baselineVersion}`,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
          BASH_ENV: prelude,
          FIXTURE_FAIL: fail ? "1" : "0",
          FIXTURE_BASELINE_VERSION: baselineVersion,
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
      if (fail) {
        expect(phases.at(-1)).toBe("verify-backup-rollback");
        expect(phases).not.toContain("assert-restored-index-rollback");
      } else if (baselineVersion === "2026.9.4") {
        expect(phases.slice(-2)).toEqual([
          "verify-backup-rollback",
          "assert-restored-index-rollback",
        ]);
      } else {
        expect(phases.slice(-2)).toEqual(["verify-backup-rollback", "verify-sole-plugin-policy"]);
      }
      expect(phases.includes("capture-sole-plugin-policy")).toBe(baselineVersion === "2026.9.2");
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
