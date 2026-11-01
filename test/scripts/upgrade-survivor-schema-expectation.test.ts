import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { packToArchive } from "../../src/plugins/test-helpers/archive-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { successSummary } from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

const schemaCommand = resolve("scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs");

function writeSchema(file: string, version: number) {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
}

async function schemaFixture(
  baselineVersion = "2026.9.2",
  stateVersion: number | null = 15,
  agentVersion: number | null = 19,
  seedState?: (stateDir: string) => void,
  candidateStateVersion = 16,
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
  writeFileSync(configFile, JSON.stringify({ agents: { entries: { main: {}, ops: {} } } }));
  const candidateDir = join(root, "package");
  mkdirSync(candidateDir);
  // Main can retain the released version while its schema contract advances.
  const candidateVersion = "2026.9.2";
  writeFileSync(
    join(candidateDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: candidateVersion,
      openclaw: { schemaVersions: { state: candidateStateVersion, agent: 19 } },
    }),
  );
  const tarball = join(root, "candidate.tgz");
  await packToArchive({ pkgDir: candidateDir, outDir: root, outName: "candidate.tgz" });
  const snapshotFile = join(root, "snapshot.json");
  const afterFile = join(root, "schema-after.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [schemaCommand, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  const prepare = () =>
    run("prepare", baselineVersion, tarball, stateDir, snapshotFile, configFile);
  const prepared = prepare();
  expect(prepared.status, prepared.stderr).toBe(0);
  function checkSchemaOutcome(
    exitCode = 0,
    installedVersion = candidateVersion,
    acceptedOutcome = "success",
  ) {
    return run(
      "assert",
      snapshotFile,
      String(exitCode),
      installedVersion,
      acceptedOutcome,
      afterFile,
    );
  }
  return {
    prepared,
    prepare,
    stateDir,
    check: checkSchemaOutcome,
    stateDatabase,
    agentDatabase,
    snapshotFile,
    afterFile,
    candidateVersion,
    run,
  };
}

async function legacyAgentFixture() {
  const agentId = "main";
  const sessionKey = `agent:${agentId}:explicit:seeded-turn`;
  const events = [
    { type: "session", id: "seeded-turn", version: 3 },
    {
      type: "message",
      id: "user-message",
      message: { role: "user", content: "Keep this history" },
    },
    {
      type: "message",
      id: "reply",
      message: { role: "assistant", content: [{ type: "text", text: "Saved reply" }] },
    },
  ];
  const index = { [sessionKey]: { sessionId: "seeded-turn" } };
  const sourceNames = [
    "sessions.json",
    "seeded-turn.jsonl",
    "seeded-turn.trajectory.jsonl",
    "seeded-turn.trajectory-path.json",
  ];
  const lane = await schemaFixture("2026.6.34", 1, null, (stateDir) => {
    const sessions = join(stateDir, "agents", agentId, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "sessions.json"), JSON.stringify(index));
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
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(
        "CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
      );
      db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(sessionKey, "seeded-turn");
      for (const [seq, event] of events.entries()) {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(
          "seeded-turn",
          seq,
          JSON.stringify(event),
        );
      }
    } finally {
      db.close();
    }
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
    writeFileSync(
      manifestPath,
      JSON.stringify({
        completedAt: "2026-09-07",
        targets: [
          { agentId, sqlitePath: databasePath, validationBeforeArchive: "passed", completedMoves },
        ],
      }),
    );
  }
  return { ...lane, migrate, databasePath, archiveDir, sessions, promptPath, manifestPath };
}

describe("published survivor schema outcome", () => {
  it.each([35, 36])(
    "binds a same-database Doctor witness to candidate schema %s",
    async (contentVersion) => {
      // Synthetic observer/parser control; the packaged lane must supply the natural tuple.
      const lane = await schemaFixture("2026.9.2", 15, 19, undefined, contentVersion);
      const snapshot = JSON.parse(readFileSync(lane.snapshotFile, "utf8"));
      snapshot.sourceSha = "c".repeat(40);
      writeFileSync(lane.snapshotFile, JSON.stringify(snapshot));
      const database = new DatabaseSync(lane.stateDatabase);
      database.exec(
        "CREATE TABLE schema_meta (meta_key TEXT, role TEXT, schema_version INTEGER); INSERT INTO schema_meta VALUES ('primary', 'global', 15); CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT)",
      );
      database
        .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
        .run("state.schema.contentVersion", JSON.stringify(contentVersion));
      database.close();
      const capture = join(dirname(lane.snapshotFile), "private-capture.json");
      const report = join(dirname(lane.snapshotFile), "private-doctor.json");
      const proofFile = join(dirname(lane.snapshotFile), "deferred-schema-doctor.json");
      const before = lane.run("doctor-before", lane.snapshotFile, capture);
      expect(before.status, before.stderr).toBe(0);
      expect(before.stdout.trim()).toBe("observed");
      const finding = {
        checkId: "core/doctor/database-engine",
        severity: "info",
        path: lane.stateDatabase,
        details: {
          family: "state",
          path: lane.stateDatabase,
          issues: [],
          schema: { version: contentVersion, expectedVersion: contentVersion, pending: 0 },
        },
      };
      const payload = { schemaVersion: 1, ok: false, checksRun: 1, findings: [finding] };
      const check = (exit = 1) =>
        lane.run("doctor-after", capture, String(exit), report, proofFile);
      writeFileSync(report, JSON.stringify(payload));
      const checked = check();
      expect(checked.status, checked.stderr).toBe(0);
      const proof = JSON.parse(readFileSync(proofFile, "utf8"));
      expect(proof).toMatchObject({
        status: "passed",
        doctorExitCode: 1,
        sameDatabase: true,
        cliFamilyUnchanged: true,
        expectedContentVersion: contentVersion,
        diagnosticVersion: contentVersion,
        pendingMigrations: 0,
      });
      expect(proof.before).toEqual({ userVersion: 15, metadataVersion: 15, contentVersion });
      expect(proof.after).toEqual(proof.before);
      const publicRoot = tempDirs.make("deferred-schema-publication-");
      const backupRollback = {
        status: "not-applicable",
        baselineVersion: "2026.9.2",
        minimumBaseline: "2026.9.4",
      };
      writeFileSync(
        join(publicRoot, "summary.json"),
        JSON.stringify({
          ...successSummary("2026.9.2", lane.candidateVersion),
          backupRollback,
          deferredSchemaDoctor: {
            ...proof,
            privateIds: JSON.parse(readFileSync(capture, "utf8")),
            rawReport: payload,
          },
        }),
      );
      publishDiagnostics(
        publicRoot,
        join(publicRoot, "public"),
        (value: string) => value,
        "passed",
      );
      const published = readFileSync(join(publicRoot, "public/summary.json"), "utf8");
      expect(JSON.parse(published).deferredSchemaDoctor).toEqual(proof);
      expect(published).not.toContain(lane.stateDir);
      expect(published).not.toContain("privateIds");
      expect(published).not.toContain("rawReport");
      const privateVersion = `${lane.candidateVersion} sensitive7319`;
      writeFileSync(
        join(publicRoot, "summary.json"),
        JSON.stringify({
          ...successSummary("2026.9.2", privateVersion),
          backupRollback,
          deferredSchemaDoctor: { ...proof, candidateVersion: privateVersion },
        }),
      );
      publishDiagnostics(
        publicRoot,
        join(publicRoot, "sanitized"),
        (value: string) => value.replaceAll("sensitive7319", "[redacted]"),
        "passed",
      );
      const sanitized = readFileSync(join(publicRoot, "sanitized/summary.json"), "utf8");
      expect(sanitized).not.toContain("sensitive7319");
      expect(JSON.parse(sanitized).deferredSchemaDoctor.candidateVersion).toBe(
        `${lane.candidateVersion} [redacted]`,
      );
      rmSync(proofFile);
      expect(check(0).status).toBe(1);
      expect(existsSync(proofFile)).toBe(false);
      for (const findings of [
        [],
        [finding, finding],
        [{ ...finding, path: join(lane.stateDir, "other.sqlite") }],
        [{ ...finding, details: { ...finding.details, path: "/private/sensitive7319" } }],
        [{ ...finding, details: { ...finding.details, issues: ["owner admission failed"] } }],
        [
          {
            ...finding,
            details: {
              ...finding.details,
              schema: { ...finding.details.schema, version: 15, pending: 20 },
            },
          },
        ],
      ]) {
        writeFileSync(report, JSON.stringify({ ...payload, findings }));
        const refused = check();
        expect(refused.status).toBe(1);
        expect(refused.stderr).not.toContain(lane.stateDir);
        expect(refused.stderr).not.toContain("sensitive7319");
        expect(existsSync(proofFile)).toBe(false);
      }
      writeFileSync(report, JSON.stringify(payload));
      const changed = new DatabaseSync(lane.stateDatabase);
      changed.exec("PRAGMA user_version = 16");
      changed.close();
      expect(check().status).toBe(1);
      expect(existsSync(proofFile)).toBe(false);
      const notObserved = lane.run("doctor-before", lane.snapshotFile, capture);
      expect(notObserved.status, notObserved.stderr).toBe(0);
      expect(notObserved.stdout.trim()).toBe("not-observed");
      const skipped = check(0);
      expect(skipped.status, skipped.stderr).toBe(0);
      const skippedProof = JSON.parse(readFileSync(proofFile, "utf8"));
      expect(skippedProof.status).toBe("not-observed");
      expect(skippedProof).not.toHaveProperty("doctorExitCode");
      expect(skippedProof).not.toHaveProperty("sameDatabase");
    },
  );

  it("retires reused witness artifacts and preserves ordinary unselected routes", () => {
    const root = tempDirs.make("deferred-schema-reuse-");
    const artifacts = [
      "deferred-schema-private.json",
      "deferred-schema-private.json.after",
      "deferred-schema-doctor-private.json",
      "deferred-schema-doctor-private.err",
      "deferred-schema-doctor.json",
    ];
    for (const file of [...artifacts, "unrelated.json"]) {
      writeFileSync(join(root, file), "PRIVATE_STALE_WITNESS");
    }
    const reset = spawnSync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; prepare_diagnostics_capture; test "$diagnostics_ready" = 1',
        "reset",
        resolve("scripts/lib/upgrade-survivor-diagnostics.sh"),
      ],
      { encoding: "utf8", env: { ...process.env, ARTIFACT_DIR: root } },
    );
    expect(reset.status, reset.stderr).toBe(0);
    for (const file of artifacts) {
      expect(existsSync(join(root, file))).toBe(false);
    }
    expect(readFileSync(join(root, "unrelated.json"), "utf8")).toBe("PRIVATE_STALE_WITNESS");
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const selection = source.match(
      /if \[ "\$SCENARIO" = "legacy-operator-state" \] && \[ "\$UPDATE_RESTART_MODE" = "manual" \] && \[ "\$baseline_version" = "2026\.9\.2" \]; then\n[\s\S]*?\nfi/,
    )?.[0];
    expect(selection).toBeDefined();
    for (const selected of ["", "c".repeat(40)]) {
      const invoked = spawnSync(
        "/bin/bash",
        ["-c", `exec 3>&1; phase() { printf '%s\\n' "$1"; }; ${selection}`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SCENARIO: "legacy-operator-state",
            UPDATE_RESTART_MODE: "manual",
            baseline_version: "2026.9.2",
            CANDIDATE_KIND: "tarball",
            OPENCLAW_DOCKER_E2E_SELECTED_SHA: selected,
          },
        },
      );
      expect(invoked.status, invoked.stderr).toBe(0);
      expect(invoked.stdout.trim()).toBe(
        selected
          ? "observe-deferred-schema-doctor"
          : "Skipping deferred-schema Doctor witness: a selected tarball source is required.",
      );
    }
  });

  it.each<{
    name: string;
    code?: number;
    outcome?: string;
    installed?: string;
    state?: number | null;
    agent?: number | null;
    accepted?: boolean;
    diagnostic?: string;
  }>([
    { name: "failed success", code: 1 },
    { name: "recoverable zero exit", outcome: "recoverable", accepted: true },
    { name: "recoverable warning", code: 1, outcome: "recoverable", accepted: true },
    { name: "unrecoverable exit", code: 2, outcome: "recoverable" },
    { name: "schema refusal", outcome: "schema-refusal" },
    { name: "state migration missing", state: 15, diagnostic: "candidate schema" },
    { name: "agent migration missing", agent: 18, diagnostic: "candidate schema" },
    { name: "state schema too new", state: 17, diagnostic: "candidate schema" },
    { name: "agent schema too new", agent: 20, diagnostic: "candidate schema" },
    { name: "state database lost", state: null, diagnostic: "candidate schema" },
    {
      name: "agent database lost",
      agent: null,
      diagnostic: "required agent database missing before candidate probes: ops",
    },
    { name: "rollback", installed: "2026.9.1", diagnostic: "candidate package is not installed" },
  ])(
    "validates the installed candidate before probes: $name",
    async ({
      code = 0,
      outcome = "success",
      installed,
      state = 16,
      agent = 19,
      accepted = false,
      diagnostic,
    }) => {
      const lane = await schemaFixture("2026.9.1", 15, 18);
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
      const result = lane.check(code, installed ?? lane.candidateVersion, outcome);
      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
      if (diagnostic) {
        expect(result.stderr).toContain(diagnostic);
      }
    },
  );

  it.each([
    [15, 18],
    [16, 19],
    [0, 0],
    [null, null],
  ] as const)(
    "requires successful migration from schemas %s/%s without observer writes",
    async (state, agent) => {
      const lane = await schemaFixture(
        state === null || state === 0 ? "2026.6.34" : "2026.9.2",
        state,
        agent,
      );
      expect(lane.prepared.stdout.trim()).toBe("success");
      expect(lane.check(1).status).toBe(1);
      if (state === null) {
        expect(JSON.parse(readFileSync(lane.snapshotFile, "utf8")).databases).toEqual([
          {
            kind: "state",
            relative: "state/openclaw.sqlite",
            userVersion: null,
            contentVersion: null,
          },
        ]);
        expect(existsSync(lane.stateDatabase)).toBe(false);
        expect(existsSync(lane.agentDatabase)).toBe(false);
      }
      writeSchema(lane.stateDatabase, 16);
      writeSchema(lane.agentDatabase, 19);
      const files = [lane.stateDatabase, lane.agentDatabase];
      const before = files.map((file) => readFileSync(file));
      const result = lane.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("success");
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    },
  );

  it("ignores model catalogs and unrelated agent files while retaining strict session classification", async () => {
    const lane = await schemaFixture("2026.7.1-2", 1, null, (stateDir) => {
      const agentDir = join(stateDir, "agents", "main", "agent");
      mkdirSync(join(agentDir, "provider-cache"), { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({ providers: { survivor: { models: [] } } }),
      );
      writeFileSync(join(agentDir, "provider-cache", "unrelated.txt"), "Not a migration specimen");
    });
    const snapshot = JSON.parse(readFileSync(lane.snapshotFile, "utf8"));
    expect(snapshot.agents).toEqual([
      {
        agentId: "main",
        databaseRelative: "agents/main/agent/openclaw-agent.sqlite",
        requiresDatabase: false,
        files: [],
      },
      {
        agentId: "ops",
        databaseRelative: "agents/ops/agent/openclaw-agent.sqlite",
        requiresDatabase: false,
        files: [],
      },
    ]);
    const sessions = join(lane.stateDir, "agents", "main", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "unknown.json"), "{}");
    const result = lane.prepare();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unclassified baseline agent specimen: agents/main/sessions/unknown.json",
    );
  });

  it("admits only the required native fixture agent and verifies its database", async () => {
    const lane = await schemaFixture("2026.9.4");
    const artifactRoot = dirname(lane.snapshotFile);
    const configFile = join(artifactRoot, "openclaw.json");
    const eligibility = join(artifactRoot, "native-assignment-eligibility.json");
    const setAgents = (ids: string[]) =>
      writeFileSync(
        configFile,
        JSON.stringify({ agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) } }),
      );
    const expectRosterRejected = () => {
      const result = lane.prepare();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("seeded agent roster changed");
    };
    setAgents(["main", "native-proof", "ops"]);
    expectRosterRejected();
    writeFileSync(eligibility, JSON.stringify({ status: "not-applicable" }));
    expectRosterRejected();
    writeFileSync(eligibility, JSON.stringify({ status: "required" }));
    const nativeDatabase = join(lane.stateDir, "agents/native-proof/agent/openclaw-agent.sqlite");
    writeSchema(nativeDatabase, 18);
    const prepared = lane.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(lane.snapshotFile, "utf8")).agents.map(
        (agent: { agentId: string }) => agent.agentId,
      ),
    ).toEqual(["main", "native-proof", "ops"]);
    writeSchema(lane.stateDatabase, 16);
    const oldSchema = lane.check();
    expect(oldSchema.status).toBe(1);
    expect(oldSchema.stderr).toContain(
      "required agent database lacks candidate schema: native-proof",
    );
    writeSchema(nativeDatabase, 19);
    expect(lane.check().status).toBe(0);
    rmSync(nativeDatabase);
    const missing = lane.check();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
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
    async (restored) => {
      const lane = await legacyAgentFixture();
      const snapshot = JSON.parse(readFileSync(lane.snapshotFile, "utf8"));
      expect(
        snapshot.agents.map((agent: { agentId: string; requiresDatabase: boolean }) => [
          agent.agentId,
          agent.requiresDatabase,
        ]),
      ).toEqual([
        ["main", true],
        ["ops", false],
      ]);
      expect(
        snapshot.agents[0].files.map((file: { kind: string }) => file.kind).toSorted(),
      ).toEqual(["legacy-store", "skill-prompt", "trajectory", "trajectory", "transcript"]);
      lane.migrate();
      if (restored) {
        const current = JSON.parse(readFileSync(lane.manifestPath, "utf8"));
        const consumed = structuredClone(current);
        const consumedArchives: string[] = [];
        for (const target of consumed.targets) {
          for (const move of target.completedMoves) {
            move.archivePath += ".consumed";
            consumedArchives.push(move.archivePath);
          }
        }
        consumed.restore = { consumedArchives };
        writeFileSync(lane.manifestPath, JSON.stringify(consumed));
        writeFileSync(join(dirname(lane.manifestPath), "reimport.json"), JSON.stringify(current));
      }
      const preserved = [
        lane.databasePath,
        lane.promptPath,
        lane.manifestPath,
        join(lane.archiveDir, "seeded-turn.jsonl.imported-1"),
      ];
      const before = preserved.map((file) => readFileSync(file));
      const result = lane.check();
      expect(result.status, result.stderr).toBe(0);
      expect(preserved.map((file) => readFileSync(file))).toEqual(before);
      expect(
        existsSync(join(lane.stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite")),
      ).toBe(false);
    },
  );

  it.each([
    [
      "required store removed",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => rmSync(lane.databasePath),
      "required agent database missing",
    ],
    [
      "old agent schema",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => writeSchema(lane.databasePath, 18),
      "required agent database lacks candidate schema",
    ],
    [
      "active legacy source",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) =>
        writeFileSync(join(lane.sessions, "sessions.json"), "{}"),
      "specimen was not retired",
    ],
    [
      "missing archive receipt",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => rmSync(lane.manifestPath),
      "lacks completed archive receipt",
    ],
    [
      "consumed archive receipt",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => {
        const manifest = JSON.parse(readFileSync(lane.manifestPath, "utf8"));
        const consumedArchives: string[] = [];
        for (const target of manifest.targets) {
          for (const move of target.completedMoves) {
            consumedArchives.push(move.archivePath);
          }
        }
        manifest.restore = { consumedArchives };
        writeFileSync(lane.manifestPath, JSON.stringify(manifest));
      },
      "lacks completed archive receipt",
    ],
    [
      "lost transcript archive",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) =>
        rmSync(join(lane.archiveDir, "seeded-turn.jsonl.imported-1")),
      "archive missing",
    ],
    [
      "changed trajectory",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) =>
        writeFileSync(join(lane.archiveDir, "seeded-turn.trajectory.jsonl.imported-1"), "changed"),
      "archive changed",
    ],
    [
      "lost prompt blob",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => rmSync(lane.promptPath),
      "skill prompt missing",
    ],
    [
      "changed prompt blob",
      (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) =>
        writeFileSync(lane.promptPath, "changed"),
      "skill prompt changed",
    ],
    ...[
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
    ].map(
      ([label, sql, diagnostic]) =>
        [
          label,
          (lane: Awaited<ReturnType<typeof legacyAgentFixture>>) => {
            const db = new DatabaseSync(lane.databasePath);
            try {
              db.exec(sql!);
            } finally {
              db.close();
            }
          },
          diagnostic,
        ] as const,
    ),
  ] as const)("rejects %s before candidate probes", async (_label, corrupt, diagnostic) => {
    const lane = await legacyAgentFixture();
    lane.migrate();
    corrupt(lane);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
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
    async (published, marker, accepted) => {
      const lane = await schemaFixture();
      writeSchema(lane.stateDatabase, published);
      const database = new DatabaseSync(lane.stateDatabase);
      try {
        database.exec(
          "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
        );
        database
          .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
          .run("state.schema.contentVersion", marker);
      } finally {
        database.close();
      }
      const before = readFileSync(lane.stateDatabase);
      const result = lane.check();
      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
      expect(readFileSync(lane.stateDatabase)).toEqual(before);
      if (accepted) {
        expect(JSON.parse(readFileSync(lane.afterFile, "utf8")).databases).toContainEqual({
          kind: "state",
          relative: "state/openclaw.sqlite",
          userVersion: published,
          contentVersion: 16,
        });
      }
    },
  );

  it.each([
    ["assert-successful-update-json", "update did not report ok"],
    ["assert-recoverable-update-json", "doctor-failed"],
  ])("rejects typed schema refusal through %s", (assertion, diagnostic) => {
    const file = join(tempDirs.make("survivor-refused-update-"), "update.json");
    writeFileSync(
      file,
      JSON.stringify({
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        before: { version: "2026.9.2" },
        after: { version: "2026.9.2" },
        steps: [
          { name: "global update", exitCode: 0 },
          { name: "global install swap", exitCode: 0 },
          {
            name: "openclaw doctor",
            exitCode: 1,
            stdoutTail: JSON.stringify({
              ok: false,
              error: { code: "update-schema-bump-unfenced" },
            }),
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [command, assertion, file, "2026.9.2", "", "2026.9.2"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });
});
