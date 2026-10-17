import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectStatus, readJson, writeJson } from "./upgrade-survivor-io.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const schemaCommand = resolve("scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs");
const runScript = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
const fileBytes = (files: string[]) => files.map((file) => readFileSync(file));

function withDatabase(file: string, action: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(file);
  try {
    action(database);
  } finally {
    database.close();
  }
}

function writeSchema(file: string, version: number) {
  mkdirSync(dirname(file), { recursive: true });
  withDatabase(file, (database) => database.exec(`PRAGMA user_version = ${version}`));
}

function expectRejected(result: ReturnType<typeof runScript>, diagnostic: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
}

function expectReadOnly(files: string[], check: () => ReturnType<typeof runScript>) {
  const before = fileBytes(files);
  const result = check();
  expectStatus(result);
  expect(fileBytes(files)).toEqual(before);
  return result;
}

function schemaFixture(
  baselineVersion = "2026.9.2",
  stateVersion: number | null = 15,
  agentVersion: number | null = 19,
  seedState?: (stateDir: string) => void,
) {
  const root = tempDirs.make("survivor-schema-expectation-");
  const stateDir = join(root, "state");
  const stateDatabase = join(stateDir, "state", "openclaw.sqlite");
  const agentDatabase = join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
  if (stateVersion !== null) {
    writeSchema(stateDatabase, stateVersion);
  }
  if (agentVersion !== null) {
    writeSchema(agentDatabase, agentVersion);
  }
  seedState?.(stateDir);
  const configFile = join(root, "openclaw.json");
  writeJson(configFile, { agents: { entries: { main: {}, ops: {} } } });
  const candidateDir = join(root, "package");
  mkdirSync(candidateDir);
  // Main can retain the released version while its schema contract advances.
  const candidateVersion = "2026.9.2";
  writeJson(join(candidateDir, "package.json"), {
    name: "openclaw",
    version: candidateVersion,
    openclaw: { schemaVersions: { state: 16, agent: 19 } },
  });
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  const snapshotFile = join(root, "snapshot.json");
  const afterFile = join(root, "schema-after.json");
  const run = (...args: string[]) => runScript(schemaCommand, ...args);
  const prepare = () =>
    run("prepare", baselineVersion, tarball, stateDir, snapshotFile, configFile);
  const prepared = prepare();
  expectStatus(prepared);
  const check = (exitCode = 0, installed = candidateVersion, outcome = "success") =>
    run("assert", snapshotFile, String(exitCode), installed, outcome, afterFile);
  return {
    prepared,
    prepare,
    stateDir,
    check,
    stateDatabase,
    agentDatabase,
    snapshotFile,
    afterFile,
    candidateVersion,
  };
}

function legacyAgentFixture() {
  const agentId = "main";
  const sessionKey = `agent:${agentId}:explicit:seeded-turn`;
  const message = (
    id: string,
    role: string,
    content: string | { type: string; text: string }[],
  ) => ({ type: "message", id, message: { role, content } });
  const events = [
    { type: "session", id: "seeded-turn", version: 3 },
    message("user-message", "user", "Keep this history"),
    message("reply", "assistant", [{ type: "text", text: "Saved reply" }]),
  ];
  const index = { [sessionKey]: { sessionId: "seeded-turn" } };
  const sourceNames = [
    "sessions.json",
    "seeded-turn.jsonl",
    "seeded-turn.trajectory.jsonl",
    "seeded-turn.trajectory-path.json",
  ];
  const lane = schemaFixture("2026.6.34", 1, null, (stateDir) => {
    const sessions = join(stateDir, "agents", agentId, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeJson(join(sessions, "sessions.json"), index);
    writeFileSync(
      join(sessions, "seeded-turn.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    writeFileSync(join(sessions, "seeded-turn.trajectory.jsonl"), '{"type":"session.started"}\n');
    writeFileSync(join(sessions, "seeded-turn.trajectory-path.json"), '{"version":1}');
    const prompt = join(sessions, "skills-prompts", "sha256", "aa", `${"a".repeat(64)}.txt`);
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, "Retained prompt");
  });
  const sessions = join(lane.stateDir, "agents", agentId, "sessions");
  const databasePath = join(lane.stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const archiveDir = join(lane.stateDir, "agents", agentId, "session-sqlite-import-archive");
  const promptPath = join(sessions, "skills-prompts", "sha256", "aa", `${"a".repeat(64)}.txt`);
  const manifestPath = join(lane.stateDir, "session-sqlite-migration-runs", "import.json");
  function migrate() {
    writeSchema(lane.stateDatabase, 16);
    writeSchema(databasePath, 19);
    withDatabase(databasePath, (db) => {
      db.exec(
        "CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
      );
      db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(sessionKey, "seeded-turn");
      const insertEvent = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)");
      for (const [seq, event] of events.entries()) {
        insertEvent.run("seeded-turn", seq, JSON.stringify(event));
      }
    });
    mkdirSync(archiveDir, { recursive: true });
    const completedMoves = sourceNames.map((name) => {
      const sourcePath = join(sessions, name);
      const archivePath = join(archiveDir, `${name}.imported-1`);
      renameSync(sourcePath, archivePath);
      return {
        sourcePath,
        archivePath,
        kind:
          name === "sessions.json"
            ? "legacy-store"
            : name.includes("trajectory")
              ? "trajectory"
              : "transcript",
      };
    });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeJson(manifestPath, {
      completedAt: "2026-09-07",
      targets: [
        { agentId, sqlitePath: databasePath, validationBeforeArchive: "passed", completedMoves },
      ],
    });
  }
  return { ...lane, migrate, databasePath, archiveDir, sessions, promptPath, manifestPath };
}

type LegacyLane = ReturnType<typeof legacyAgentFixture>;

function consumeManifest(lane: LegacyLane, suffix = "") {
  const manifest = readJson(lane.manifestPath);
  const consumedArchives = manifest.targets.flatMap(
    (target: { completedMoves: { archivePath: string }[] }) =>
      target.completedMoves.map((move) => (move.archivePath += suffix)),
  );
  writeJson(lane.manifestPath, { ...manifest, restore: { consumedArchives } });
}

describe("published survivor schema outcome", () => {
  it.each([
    [1, "success", false],
    [0, "recoverable", true],
    [1, "recoverable", true],
    [2, "recoverable", false],
    [0, "schema-refusal", false],
  ] as const)("validates exit %i with outcome %s before probes", (code, outcome, accepted) => {
    const lane = schemaFixture("2026.9.1", 15, 18);
    writeSchema(lane.stateDatabase, 16);
    writeSchema(lane.agentDatabase, 19);
    expectStatus(lane.check(code, lane.candidateVersion, outcome), accepted ? 0 : 1);
  });

  it.each([
    [15, 19, "2026.9.2", "candidate schema"],
    [16, 18, "2026.9.2", "candidate schema"],
    [17, 19, "2026.9.2", "candidate schema"],
    [16, 20, "2026.9.2", "candidate schema"],
    [null, 19, "2026.9.2", "candidate schema"],
    [16, null, "2026.9.2", "required agent database missing before candidate probes: ops"],
    [16, 19, "2026.9.1", "candidate package is not installed"],
  ] as const)(
    "requires candidate schemas %s/%s and version %s before probes",
    (state, agent, installed, diagnostic) => {
      const lane = schemaFixture("2026.9.1", 15, 18);
      for (const [file, version] of [
        [lane.stateDatabase, state],
        [lane.agentDatabase, agent],
      ] as const) {
        if (version === null) {
          rmSync(file);
        } else {
          writeSchema(file, version);
        }
      }
      expectRejected(lane.check(0, installed), diagnostic);
    },
  );

  it.each([
    [15, 18],
    [16, 19],
    [0, 0],
    [null, null],
  ] as const)(
    "requires successful migration from schemas %s/%s without observer writes",
    (state, agent) => {
      const lane = schemaFixture(
        state === null || state === 0 ? "2026.6.34" : "2026.9.2",
        state,
        agent,
      );
      expect(lane.prepared.stdout.trim()).toBe("success");
      expect(lane.check(1).status).toBe(1);
      if (state === null) {
        expect(readJson(lane.snapshotFile).databases).toEqual([
          {
            kind: "state",
            relative: "state/openclaw.sqlite",
            userVersion: null,
            contentVersion: null,
          },
        ]);
        expect([lane.stateDatabase, lane.agentDatabase].map(existsSync)).toEqual([false, false]);
      }
      writeSchema(lane.stateDatabase, 16);
      writeSchema(lane.agentDatabase, 19);
      const result = expectReadOnly([lane.stateDatabase, lane.agentDatabase], lane.check);
      expect(result.stdout.trim()).toBe("success");
    },
  );

  it("ignores model catalogs and unrelated agent files while retaining strict session classification", () => {
    const lane = schemaFixture("2026.7.1-2", 1, null, (stateDir) => {
      const agentDir = join(stateDir, "agents", "main", "agent");
      mkdirSync(join(agentDir, "provider-cache"), { recursive: true });
      writeJson(join(agentDir, "models.json"), { providers: { survivor: { models: [] } } });
      writeFileSync(join(agentDir, "provider-cache", "unrelated.txt"), "Not a migration specimen");
    });
    const snapshot = readJson(lane.snapshotFile);
    expect(snapshot.agents).toEqual(
      ["main", "ops"].map((agentId) => ({
        agentId,
        databaseRelative: `agents/${agentId}/agent/openclaw-agent.sqlite`,
        requiresDatabase: false,
        files: [],
      })),
    );
    const sessions = join(lane.stateDir, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "unknown.json"), "{}");
    expectRejected(
      lane.prepare(),
      "unclassified baseline agent specimen: agents/main/sessions/unknown.json",
    );
  });

  it("admits only the required native fixture agent and verifies its database", () => {
    const lane = schemaFixture("2026.9.4");
    const artifactRoot = dirname(lane.snapshotFile);
    const configFile = join(artifactRoot, "openclaw.json");
    const eligibility = join(artifactRoot, "native-assignment-eligibility.json");
    const setAgents = (ids: string[]) =>
      writeJson(configFile, { agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) } });
    const expectRosterRejected = () =>
      expectRejected(lane.prepare(), "seeded agent roster changed");
    setAgents(["main", "native-proof", "ops"]);
    expectRosterRejected();
    writeJson(eligibility, { status: "not-applicable" });
    expectRosterRejected();
    writeJson(eligibility, { status: "required" });
    const nativeDatabase = join(lane.stateDir, "agents/native-proof/agent/openclaw-agent.sqlite");
    writeSchema(nativeDatabase, 18);
    const prepared = lane.prepare();
    expectStatus(prepared);
    expect(
      readJson(lane.snapshotFile).agents.map((agent: { agentId: string }) => agent.agentId),
    ).toEqual(["main", "native-proof", "ops"]);
    writeSchema(lane.stateDatabase, 16);
    expectRejected(lane.check(), "required agent database lacks candidate schema: native-proof");
    writeSchema(nativeDatabase, 19);
    expect(lane.check().status).toBe(0);
    rmSync(nativeDatabase);
    expectRejected(
      lane.check(),
      "required agent database missing before candidate probes: native-proof",
    );
    for (const ids of [
      ["main", "ops"],
      ["native-proof", "ops"],
      ["main", "native-proof"],
      ["main", "native-proof", "ops", "unexpected"],
    ]) {
      setAgents(ids);
      expectRosterRejected();
    }
  });

  it.each([false, true])(
    "verifies every legacy specimen, including a restored receipt (%s)",
    (restored) => {
      const lane = legacyAgentFixture();
      const snapshot = readJson(lane.snapshotFile);
      expect(snapshot.agents).toMatchObject([
        { agentId: "main", requiresDatabase: true },
        { agentId: "ops", requiresDatabase: false },
      ]);
      expect(
        snapshot.agents[0].files.map((file: { kind: string }) => file.kind).toSorted(),
      ).toEqual(["legacy-store", "skill-prompt", "trajectory", "trajectory", "transcript"]);
      lane.migrate();
      if (restored) {
        const current = readJson(lane.manifestPath);
        consumeManifest(lane, ".consumed");
        writeJson(join(dirname(lane.manifestPath), "reimport.json"), current);
      }
      const preserved = [
        lane.databasePath,
        lane.promptPath,
        lane.manifestPath,
        join(lane.archiveDir, "seeded-turn.jsonl.imported-1"),
      ];
      expectReadOnly(preserved, lane.check);
      expect(existsSync(lane.agentDatabase)).toBe(false);
    },
  );

  it.each([
    ["required store removed", "remove", "database", "required agent database missing"],
    ["old agent schema", "schema", "database", "required agent database lacks candidate schema"],
    ["active legacy source", "write", "index", "specimen was not retired"],
    ["missing archive receipt", "remove", "manifest", "lacks completed archive receipt"],
    ["consumed archive receipt", "consume", "manifest", "lacks completed archive receipt"],
    ["lost transcript archive", "remove", "transcript", "archive missing"],
    ["changed trajectory", "write", "trajectory", "archive changed"],
    ["lost prompt blob", "remove", "prompt", "skill prompt missing"],
    ["changed prompt blob", "write", "prompt", "skill prompt changed"],
  ] as const)("rejects %s before candidate probes", (_label, operation, target, diagnostic) => {
    const lane = legacyAgentFixture();
    lane.migrate();
    const file = {
      database: lane.databasePath,
      index: join(lane.sessions, "sessions.json"),
      manifest: lane.manifestPath,
      transcript: join(lane.archiveDir, "seeded-turn.jsonl.imported-1"),
      trajectory: join(lane.archiveDir, "seeded-turn.trajectory.jsonl.imported-1"),
      prompt: lane.promptPath,
    }[target];
    const corrupt = {
      remove: () => rmSync(file),
      schema: () => writeSchema(file, 18),
      consume: () => consumeManifest(lane),
      write: () => writeFileSync(file, target === "index" ? "{}" : "changed"),
    };
    corrupt[operation]();
    expectRejected(lane.check(), diagnostic);
  });

  it.each([
    ["session row", "DELETE FROM session_nodes", "legacy session was not imported"],
    [
      "transcript event",
      "DELETE FROM transcript_events WHERE seq = 2",
      "legacy transcript event was not imported",
    ],
    [
      "message content",
      `UPDATE transcript_events SET event_json = '{"type":"message","id":"reply","message":{"role":"assistant","content":"lost reply"}}' WHERE seq = 2`,
      "legacy transcript event was not imported",
    ],
  ] as const)("rejects missing or changed %s before probes", (_label, sql, diagnostic) => {
    const lane = legacyAgentFixture();
    lane.migrate();
    withDatabase(lane.databasePath, (db) => db.exec(sql));
    expectRejected(lane.check(), diagnostic);
  });

  it.each([
    [15, "16", true],
    [16, "15", true],
    [15, "15", false],
    [16, "17", false],
    [15, '"16"', false],
    [15, "-1", false],
    [15, "broken", false],
  ] as const)(
    "observes published schema %i with content marker %s without changing it",
    (published, marker, accepted) => {
      const lane = schemaFixture();
      writeSchema(lane.stateDatabase, published);
      withDatabase(lane.stateDatabase, (database) => {
        database.exec(
          "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
        );
        database
          .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
          .run("state.schema.contentVersion", marker);
      });
      const before = readFileSync(lane.stateDatabase);
      const result = lane.check();
      expectStatus(result, accepted ? 0 : 1);
      expect(readFileSync(lane.stateDatabase)).toEqual(before);
      if (accepted) {
        expect(readJson(lane.afterFile).databases).toContainEqual({
          kind: "state",
          relative: "state/openclaw.sqlite",
          userVersion: published,
          contentVersion: 16,
        });
      }
    },
  );
});
