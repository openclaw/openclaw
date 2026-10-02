import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
  PREVIOUS_VERSION,
  readDatabaseSnapshot,
  writeArchive,
  type FixtureEvent,
} from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupMediaPersistenceFixtures(tempDirs);
});

describe("legacy media persistence doctor migration", () => {
  it("cancels pending integrity before migrating the agent schema", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-interruption-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const pathname = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 21 });
    const controller = new AbortController();
    const interruption = new Error("Doctor interrupted by SIGTERM");
    let entered!: () => void;
    const checking = new Promise<boolean>((resolve) => {
      entered = () => resolve(true);
    });
    const check = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async () => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(interruption), {
            once: true,
          });
        });
      });
    const migration = withSqliteReadOnlyWorkerScope(() => migrateLegacyMediaPersistence({ env }), {
      signal: controller.signal,
      deadlineOwnedByCaller: false,
    });
    try {
      expect(await Promise.race([checking, migration.then(() => false)])).toBe(true);
    } finally {
      controller.abort(interruption);
      await migration;
      check.mockRestore();
    }
    expect((await migration).warnings.join("\n")).toContain("Doctor interrupted by SIGTERM");
    const database = new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
    } finally {
      database.close();
    }
  });

  it("preserves the typed maintenance cause when lease acquisition fails", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-lease-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    closeOpenClawStateDatabaseForTest();
    const location = nodeSqlite.resolveExistingSqliteFileUri(resolveOpenClawStateSqlitePath(env));
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((file, options) => {
        if (file === location && !options?.readOnly) {
          throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
        }
        return openDatabase(file, options);
      });
    try {
      const result = await migrateLegacyMediaPersistence({ env });
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rewrites every active shape and trajectory snapshot, migrates mixed archives, and reruns as a no-op", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-migration-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const legacy = createEvent({
      id: "event-legacy",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        MediaPaths: ["/media/a.ogg", "/media/b.png"],
        MediaTypes: ["audio", "image/png"],
        MediaTranscribedIndexes: [0],
        MediaWorkspaceDir: "/workspace",
      },
    });
    const conflict = createEvent({
      id: "event-conflict",
      parentId: "event-legacy",
      timestamp: 2000,
      message: {
        role: "user",
        content: "conflict",
        MediaPath: "/legacy.png",
        MediaType: "image/png",
        __openclaw: {
          traceId: "trace-1",
          media: [{ path: "/canonical.jpg", contentType: "image/jpeg" }],
        },
      },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        "session-a": [legacy, conflict],
        "session-b": [
          createEvent({
            id: "event-sparse",
            parentId: null,
            timestamp: 3000,
            message: {
              role: "user",
              content: "sparse",
              MediaPaths: ["", "/media/c.pdf"],
              MediaTypes: ["", "application/pdf"],
            },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const trajectoryDatabase = new DatabaseSync(databasePath);
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        0,
        "run-1",
        JSON.stringify({
          type: "model.completed",
          data: {
            messagesSnapshot: [legacy.message],
            modelOutput: "done",
            timing: { totalMs: 125 },
            toolTraces: [{ name: "read", durationMs: 5 }],
          },
        }),
        4000,
      );
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        1,
        "run-1",
        JSON.stringify({ data: { toolArguments: { MediaPath: "/not-a-message-field" } } }),
        4001,
      );
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        2,
        "run-1",
        JSON.stringify({
          data: {
            messagesSnapshot: [{ role: "user", media: [{ path: "/legacy-top-level.png" }] }],
          },
        }),
        4002,
      );
    const emptyCarrierEventJson = JSON.stringify({
      type: "model.completed",
      data: {
        messagesSnapshot: [
          { role: "user", content: "empty", media: [], MediaPaths: [], MediaTypes: [] },
        ],
        modelOutput: "empty",
      },
    });
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run("session-a", 3, "run-1", emptyCarrierEventJson, 4003);
    trajectoryDatabase.close();

    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const plainArchive = path.join(archiveDir, "cold-plain.jsonl.deleted.2026-07-24T01-02-03.000Z");
    const compressedArchive = `${path.join(
      archiveDir,
      "cold-zstd.jsonl.reset.2026-07-24T01-02-04.000Z",
    )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
    writeArchive(plainArchive, [legacy], false);
    writeArchive(compressedArchive, [conflict], true);

    const before = readDatabaseSnapshot(databasePath);
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(4);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        `Upgraded agent database schema in ${databasePath}: v16 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated media persistence in ${databasePath}: 2 transcript session(s), 2 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated archived transcript media in ${plainArchive}.`,
        `Migrated archived transcript media in ${compressedArchive}.`,
      ]),
    );

    const after = readDatabaseSnapshot(databasePath);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(after.trajectoryCount).toBe(4);
    expect(after.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row)).toEqual(
      before.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row),
    );
    const migratedTrajectory = JSON.parse(after.trajectoryRows[0]?.event_json ?? "null") as {
      data?: Record<string, unknown>;
    };
    expect(migratedTrajectory.data).toMatchObject({
      modelOutput: "done",
      timing: { totalMs: 125 },
      toolTraces: [{ name: "read", durationMs: 5 }],
    });
    const migratedMessagesSnapshot = migratedTrajectory.data?.messagesSnapshot;
    expect(migratedMessagesSnapshot).toBeInstanceOf(Array);
    const migratedTrajectoryMessage = (
      migratedMessagesSnapshot as Array<Record<string, unknown>>
    )[0];
    expect(migratedTrajectoryMessage).not.toHaveProperty("MediaPaths");
    expect(migratedTrajectoryMessage?.["__openclaw"]).toMatchObject({
      media: [
        expect.objectContaining({ path: "/media/a.ogg" }),
        expect.objectContaining({ path: "/media/b.png" }),
      ],
    });
    expect(after.trajectoryRows[1]?.event_json).toBe(before.trajectoryRows[1]?.event_json);
    const topLevelMediaMessage = (
      JSON.parse(after.trajectoryRows[2]?.event_json ?? "null") as {
        data: { messagesSnapshot: Array<Record<string, unknown>> };
      }
    ).data.messagesSnapshot[0];
    expect(topLevelMediaMessage).not.toHaveProperty("media");
    expect(topLevelMediaMessage?.["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/legacy-top-level.png" })],
    });
    expect(after.trajectoryRows[3]?.event_json).toBe(emptyCarrierEventJson);
    expect(after.rows.map((row) => row.created_at)).toEqual(
      before.rows.map((row) => row.created_at),
    );
    expect(after.identities).toEqual(before.identities);
    expect(after.activeBranch).toEqual(before.activeBranch);
    expect(after.windows).toEqual(before.windows);
    expect(after.generations).not.toEqual(before.generations);
    const messages = after.rows.map((row) => (JSON.parse(row.event_json) as FixtureEvent).message);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        __openclaw: {
          media: [
            expect.objectContaining({ kind: "audio", transcribed: true }),
            expect.objectContaining({ contentType: "image/png" }),
          ],
        },
      }),
      expect.objectContaining({
        __openclaw: {
          traceId: "trace-1",
          media: [expect.objectContaining({ path: "/canonical.jpg" })],
        },
      }),
      expect.objectContaining({
        __openclaw: {
          media: [expect.any(Object), expect.objectContaining({ path: "/media/c.pdf" })],
        },
      }),
    ]);
    for (const message of messages) {
      expect(JSON.stringify(message)).not.toMatch(/"Media(?:Path|Paths|Type|Types|Url|Urls)/u);
    }
    expect(readSessionArchiveContentSync(plainArchive)).toContain('"__openclaw"');
    expect(readSessionArchiveContentSync(compressedArchive)).toContain('"__openclaw"');

    expect(openOpenClawAgentDatabase({ agentId: "main", env }).db.isOpen).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
  });

  it("migrates when valid transcript created_at rows have an unsafe aggregate", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-large-created-at-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const legacyMediaPaths = ["/media/a.png", "/media/b.png"];
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        unsafe: legacyMediaPaths.map((mediaPath, index) =>
          createEvent({
            id: `event-${index + 1}`,
            parentId: index === 0 ? null : "event-1",
            timestamp: (index + 1) * 1000,
            message: { role: "user", content: `message ${index + 1}`, MediaPath: mediaPath },
          }),
        ),
      },
    });
    const largeCreatedAt = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 100;
    expect(largeCreatedAt * 2).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE transcript_events SET created_at = ? WHERE session_id = ?")
      .run(largeCreatedAt, "unsafe");
    database.close();

    expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);

    const snapshot = readDatabaseSnapshot(databasePath);
    expect(snapshot.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(snapshot.rows.map((row) => row.created_at)).toEqual([largeCreatedAt, largeCreatedAt]);
    const messages = snapshot.rows.map(
      (row) => (JSON.parse(row.event_json) as FixtureEvent).message,
    );
    expect(messages).toEqual(
      legacyMediaPaths.map((mediaPath) =>
        expect.objectContaining({
          __openclaw: { media: [expect.objectContaining({ path: mediaPath })] },
        }),
      ),
    );
  });

  it.each([OPENCLAW_AGENT_SCHEMA_VERSION])(
    "canonicalizes retired media carriers on every transcript message role at schema v%s",
    async (schemaVersion) => {
      const stateDir = makeTempDir(tempDirs, "media-persistence-message-roles-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = createLegacyDatabaseFixture({
        env,
        schemaVersion,
        eventsBySession: {
          roles: [
            createEvent({
              id: "event-assistant",
              parentId: null,
              timestamp: 1000,
              message: { role: "assistant", content: "result", MediaPath: "/media/result.png" },
            }),
            createEvent({
              id: "event-roleless",
              parentId: "event-assistant",
              timestamp: 2000,
              message: { content: "imported", MediaPath: "/media/imported.png" },
            }),
          ],
        },
      });

      const scope = createOpenClawDatabaseMaintenanceScope();
      if (schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
        scope.addAgentSchemaMigrationCheck(() => {
          throw new Error("Same-schema media cleanup must not require versioned backup coverage");
        });
      }
      let result: Awaited<ReturnType<typeof migrateLegacyMediaPersistence>>;
      try {
        result = await scope.run(() => migrateLegacyMediaPersistence({ env }));
      } finally {
        await scope.close();
      }
      expect(result).toEqual({
        changes: [
          ...(schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION
            ? [
                `Upgraded agent database schema in ${databasePath}: v${schemaVersion} -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
              ]
            : []),
          `Migrated media persistence in ${databasePath}: 1 transcript session(s), 0 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        ],
        warnings: [],
      });
      const messages = readDatabaseSnapshot(databasePath).rows.map(
        (row) => (JSON.parse(row.event_json) as FixtureEvent).message,
      );
      expect(messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          __openclaw: { media: [expect.objectContaining({ path: "/media/result.png" })] },
        }),
        expect.objectContaining({
          __openclaw: { media: [expect.objectContaining({ path: "/media/imported.png" })] },
        }),
      ]);
      for (const message of messages) {
        expect(message).not.toHaveProperty("MediaPath");
      }
      expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
    },
  );

  it.each([
    { schemaVersion: PREVIOUS_VERSION, kind: "transcript" },
    { schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION, kind: "trajectory" },
  ])(
    "rolls back late invalid $kind JSON at schema v$schemaVersion",
    async ({ schemaVersion, kind }) => {
      const stateDir = makeTempDir(tempDirs, "media-persistence-corrupt-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = createLegacyDatabaseFixture({
        env,
        schemaVersion,
        eventsBySession: {
          corrupt: Array.from({ length: kind === "transcript" ? 65 : 1 }, (_, index) =>
            createEvent({
              id: `event-${index}`,
              parentId: index === 0 ? null : `event-${index - 1}`,
              timestamp: 1000 + index,
              message: {
                role: "user",
                content: "preserved",
                ...(index === 0 ? { MediaPath: "/media/a.png" } : {}),
              },
            }),
          ),
        },
      });
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(databasePath);
      if (kind === "transcript") {
        database
          .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 64")
          .run("{broken", "corrupt");
      } else {
        const insert = database.prepare(
          "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
        );
        for (let seq = 0; seq <= 64; seq += 1) {
          insert.run(
            "corrupt",
            seq,
            "run-1",
            seq === 64
              ? "{broken"
              : JSON.stringify({
                  data: {
                    messagesSnapshot: [{ role: "user", MediaPath: "/media/trajectory.png" }],
                  },
                }),
            2000 + seq,
          );
        }
      }
      database.close();

      if (schemaVersion === PREVIOUS_VERSION) {
        expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
          "run openclaw doctor --fix to migrate persisted media",
        );
        closeOpenClawAgentDatabasesForTest();
      }
      const before = readDatabaseSnapshot(databasePath);
      const result = await migrateLegacyMediaPersistence({ env });
      expect(result.warnings).toHaveLength(1);
      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain(`Skipped agent database migration for ${databasePath}:`);
      expect(result.warnings[0]).toContain(`invalid ${kind} JSON`);
      expect(readDatabaseSnapshot(databasePath)).toEqual(before);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
        schemaVersion === PREVIOUS_VERSION
          ? []
          : [expect.objectContaining({ path: databasePath, schemaVersion })],
      );
      expect(
        listOpenClawRegisteredAgentDatabases({
          env,
          includeIncompatibleSchemaVersions: true,
        }),
      ).toEqual([expect.objectContaining({ path: databasePath, schemaVersion })]);
    },
  );

  it("aborts on active-row drift and archive source replacement without partial deletion", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-drift-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { DatabaseSync } = requireNodeSqlite();
    const event = createEvent({
      id: "event-1",
      parentId: null,
      timestamp: 1000,
      message: { role: "user", content: "before", MediaPath: "/media/a.png" },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: { drift: [event] },
    });
    const transcriptDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeDatabaseTransaction: (pathname) => {
          if (pathname !== databasePath) {
            return;
          }
          const writer = new DatabaseSync(databasePath);
          writer
            .prepare(
              "UPDATE transcript_events SET created_at = created_at + 1 WHERE session_id = ?",
            )
            .run("drift");
          writer.close();
        },
      },
    });
    expect(transcriptDrift.warnings.join("\n")).toContain("source changed");
    expect(readDatabaseSnapshot(databasePath).version.user_version).toBe(PREVIOUS_VERSION);

    const trajectoryWriter = new DatabaseSync(databasePath);
    trajectoryWriter
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "drift",
        0,
        "run-1",
        JSON.stringify({ data: { messagesSnapshot: [{ role: "user", MediaPath: "/old.png" }] } }),
        2000,
      );
    trajectoryWriter.close();
    const trajectoryDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeDatabaseTransaction: (pathname) => {
          if (pathname !== databasePath) {
            return;
          }
          const writer = new DatabaseSync(databasePath);
          writer
            .prepare(
              "UPDATE trajectory_runtime_events SET event_json = ? WHERE session_id = ? AND seq = 0",
            )
            .run(
              JSON.stringify({
                data: { messagesSnapshot: [{ role: "user", MediaPath: "/changed.png" }] },
              }),
              "drift",
            );
          writer.close();
        },
      },
    });
    expect(trajectoryDrift.warnings.join("\n")).toContain("trajectory source changed");
    expect(readDatabaseSnapshot(databasePath).version.user_version).toBe(PREVIOUS_VERSION);

    const archivePath = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "drift.jsonl.deleted.2026-07-24T01-02-03.000Z",
    );
    writeArchive(archivePath, [event], false);
    const archiveDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeArchiveReplace: (candidate) => {
          if (candidate === archivePath) {
            fs.writeFileSync(archivePath, "replacement\n");
          }
        },
      },
    });
    expect(archiveDrift.warnings.join("\n")).toContain("changed before atomic");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement\n");
  });
});

function createArchiveFixture(bytes: Uint8Array): {
  archivePath: string;
  env: NodeJS.ProcessEnv;
} {
  const stateDir = fs.realpathSync(makeTempDir(tempDirs, "media-persistence-archive-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabasesForTest();
  const archivePath = path.join(
    stateDir,
    "agents",
    "main",
    "sessions",
    "fixture.jsonl.deleted.2026-07-24T01-02-03.000Z",
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, bytes);
  return { archivePath, env };
}

describe("legacy media persistence NUL-tail recovery", () => {
  it("atomically removes a terminal NUL suffix from an otherwise valid archive", async () => {
    const valid = Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n`);
    const { archivePath, env } = createArchiveFixture(Buffer.concat([valid, Buffer.alloc(284)]));
    let replacements = 0;

    const result = await migrateLegacyMediaPersistence({
      env,
      hooks: { beforeArchiveReplace: () => (replacements += 1) },
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated archived transcript media in ${archivePath}.`);
    expect(replacements).toBe(1);
    expect(fs.readFileSync(archivePath)).toEqual(valid);
  });

  it.each([
    { name: "an all-NUL file", bytes: Buffer.alloc(284) },
    {
      name: "a blank record",
      bytes: Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n\n`),
    },
  ])("rejects and preserves $name", async ({ bytes }) => {
    const { archivePath, env } = createArchiveFixture(bytes);
    let replacements = 0;

    const result = await migrateLegacyMediaPersistence({
      env,
      hooks: { beforeArchiveReplace: () => (replacements += 1) },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Skipped archived transcript media migration");
    expect(result.warningDisposition).toBe("recoverable");
    expect(replacements).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
  });

  it.each([{ name: "an empty file", bytes: Buffer.alloc(0) }])(
    "does not rewrite $name",
    async ({ bytes }) => {
      const { archivePath, env } = createArchiveFixture(bytes);
      const before = fs.lstatSync(archivePath);
      let replacements = 0;

      const result = await migrateLegacyMediaPersistence({
        env,
        hooks: { beforeArchiveReplace: () => (replacements += 1) },
      });

      const after = fs.lstatSync(archivePath);
      expect(result).toEqual({ changes: [], warnings: [] });
      expect(replacements).toBe(0);
      expect(fs.readFileSync(archivePath)).toEqual(bytes);
      expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }).toEqual({
        dev: before.dev,
        ino: before.ino,
        mtimeMs: before.mtimeMs,
        size: before.size,
      });
    },
  );
});

describe("legacy media persistence archive doctor migration", () => {
  it("rejects ambiguous sparse arrays and ignores stale interrupted temp files", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-sparse-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const archivePath = path.join(archiveDir, "sparse.jsonl.bak.2026-07-24T01-02-03.000Z");
    const event = createEvent({
      id: "event-1",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      },
    });
    writeArchive(archivePath, [event], false);
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "ambiguous sparse positional alignment",
    );
    fs.unlinkSync(archivePath);

    const corruptArchivePath = path.join(
      archiveDir,
      "corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
    );
    fs.writeFileSync(corruptArchivePath, "{broken\n");
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "invalid transcript JSON",
    );
    expect(fs.readFileSync(corruptArchivePath, "utf8")).toBe("{broken\n");
    fs.unlinkSync(corruptArchivePath);

    writeArchive(
      archivePath,
      [
        createEvent({
          id: "event-1",
          parentId: null,
          timestamp: 1000,
          message: { role: "user", MediaPath: "/media/a.png", MediaType: "image/png" },
        }),
      ],
      false,
    );
    fs.writeFileSync(`${archivePath}.media-retirement.999.interrupted.tmp`, "partial");
    expect((await migrateLegacyMediaPersistence({ env })).changes.join("\n")).toContain(
      "Migrated archived transcript media",
    );
    expect(readSessionArchiveContentSync(archivePath)).toContain('"__openclaw"');
  });
});
