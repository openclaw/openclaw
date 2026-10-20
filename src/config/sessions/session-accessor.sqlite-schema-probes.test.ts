import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { listSessionEntriesCore, listSessionEntriesReadOnly } from "./session-accessor.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { runSessionEntryWorkerMutation } from "./session-accessor.sqlite-replacement-worker.js";
import {
  measureSessionSchemaProbes,
  measureSqliteSchemaProbes,
  type SessionProbeOperations,
} from "./session-accessor.sqlite-schema-probes.test-support.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  markCanonicalSessionValidationPending,
  readCanonicalSessionMainKey,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const noProbes = { admitted: true, schemaVersion: 0, userVersion: 0, dataVersion: 0 };
const cronKeys = [
  "agent:main:cron:job:run:old",
  "agent:main:cron:job:run:recent",
  "agent:other:cron:job:run:old",
];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it("refreshes admitted session readers after worker commits without schema or freshness probes", async () => {
  const options = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-schema-probes-") },
  };
  const writer = openOpenClawAgentDatabase(options);
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  if (!reader.found) {
    throw new Error("Session probe reader is missing");
  }
  const nativeWriter = requireNativeSqliteDatabase(writer.db);
  const withWrite = (run: (database: typeof writer) => void) =>
    withOpenClawAgentDatabaseWrite(options, run, nativeWriter);
  const writeProbe = (label?: string, database = writer) =>
    writeSessionEntry(database, "agent:main:probe", {
      sessionId: "probe",
      updatedAt: 1,
      ...(label === undefined ? {} : { label }),
    });
  const broker = new SqliteWorkerBroker();
  try {
    const worker = await broker.open<SessionProbeOperations>({
      moduleUrl: new URL(
        "./session-accessor.sqlite-schema-probes.test-support.ts",
        import.meta.url,
      ),
      databasePath: writer.path,
      input: undefined,
    });
    if (!worker) {
      throw new Error("Session probe worker is unavailable");
    }
    const mainKey = () => worker.execute({ type: "mainKey", input: undefined });
    const expectMainKey = async (value: string) =>
      expect(await mainKey()).toEqual({ mainKey: value, statements: 0 });
    const lookupDatabase = openOpenClawAgentDatabase({
      ...options,
      path: path.join(path.dirname(writer.path), "lookup-traffic.sqlite"),
    });
    expect(readCanonicalSessionMainKey(lookupDatabase)).toBe("main");
    expect(
      await worker.execute({ type: "mainKeyLookupTraffic", input: { path: lookupDatabase.path } }),
    ).toEqual({
      mainKeys: ["main", "main", "main"],
      lookupMessages: 0,
      workerPublishRefused: true,
    });
    const raced = await broker.runOperation(
      worker,
      (scope) => scope.execute({ type: "mainKey", input: { yieldAfterRead: true } }),
      undefined,
      undefined,
      () => ({
        nativeLocations: [writer.path],
        admission: createSqliteWorkerOperationAdmission((_request, grant) => {
          setCanonicalSqliteSessionMainKey(writer, "configured-during-read");
          writer.db.exec("CREATE TABLE main_key_race_unrelated (value TEXT)");
          admitSqliteSchema(requireNativeSqliteDatabase(writer.db));
          grant();
        }),
      }),
    );
    const afterRace = await mainKey();
    expect({ raced, afterRace }).toEqual({
      raced: { mainKey: "configured-during-read", statements: 1 },
      afterRace: { mainKey: "configured-during-read", statements: 0 },
    });
    setCanonicalSqliteSessionMainKey(writer, "main");
    writeProbe();
    const borrowed = withOpenClawAgentDatabaseReadOnly(measureSessionSchemaProbes, options);
    if (!borrowed.found) {
      throw new Error("Session probe borrowed reader is missing");
    }
    const results = {
      writer: measureSessionSchemaProbes(writer),
      readOnly: measureSessionSchemaProbes(reader.database),
      snapshot: runSqliteReadSnapshotSync(reader.database.db, () =>
        measureSessionSchemaProbes(reader.database),
      ),
      borrowed: borrowed.value,
      worker: await worker.execute({ type: "read", input: undefined }),
    };
    for (const result of Object.values(results).flatMap(Object.values)) {
      expect(result).toMatchObject(noProbes);
    }
    const writes = observeHostDataSql();
    try {
      await replaceSessionEntry(
        { ...options, storePath: writer.path, sessionKey: "agent:main:probe" },
        { sessionId: "probe", updatedAt: 1, label: "worker-committed" },
      );
      expect(
        writes.queries.filter((sql) => /^(?:INSERT|UPDATE|DELETE)\b/iu.test(sql.trim())),
      ).toEqual([]);
    } finally {
      writes.restore();
    }
    const refreshed = [
      measureSessionSchemaProbes(writer, "worker-committed"),
      measureSessionSchemaProbes(reader.database, "worker-committed"),
      await worker.execute({ type: "read", input: { label: "worker-committed" } }),
    ];
    for (const result of refreshed.flatMap(Object.values)) {
      expect(result).toMatchObject(noProbes);
    }
    expect(readCanonicalSessionMainKey(writer)).toBe("main");
    await expectMainKey("main");
    let fixtureWriteStarted = false;
    let configured: Promise<void> | undefined;
    await runSessionEntryWorkerMutation(
      { ...options, path: writer.path },
      undefined,
      () => {},
      (maintenance) =>
        maintenance.execute({
          type: "session.maintenance.metadata",
          input: { kind: "maintenance-statistics" },
        }),
      {
        identityAgentId: options.agentId,
        beforeCommit() {
          // The real maintenance connection holds SQLite until this grant returns.
          configured = withWrite(() => {
            fixtureWriteStarted = true;
            runOpenClawAgentWriteTransaction((database) => {
              setCanonicalSqliteSessionMainKey(database, "intermediate");
              setCanonicalSqliteSessionMainKey(database, "configured");
              expect(readCanonicalSessionMainKey(database)).toBe("configured");
              expect(readCanonicalSessionMainKey(reader.database)).toBe("main");
            }, options);
          });
          expect(fixtureWriteStarted).toBe(false);
        },
      },
    );
    await configured;
    expect(fixtureWriteStarted).toBe(true);
    expect(readCanonicalSessionMainKey(reader.database)).toBe("configured");
    await expectMainKey("configured");
    await withWrite(() => {
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          setCanonicalSqliteSessionMainKey(database, "abandoned");
          expect(readCanonicalSessionMainKey(database)).toBe("abandoned");
          throw new Error("rollback main key");
        }, options),
      ).toThrow("rollback main key");
    });
    expect((await mainKey()).mainKey).toBe("configured");
    await expectMainKey("configured");
    // Exercise both native execution paths with statements retained before observation.
    const probeGroups = [
      ["schema_version", "user_version", "data_version"].map((name) =>
        nativeWriter.prepare(`PRAGMA ${name}`),
      ),
      [
        nativeWriter.prepare(`SELECT schema_version, user_version, data_version
          FROM main.pragma_schema_version(), main.pragma_user_version(), main.pragma_data_version()`),
      ],
    ];
    for (const statements of probeGroups) {
      for (const method of ["get", "all", "iterate"] as const) {
        const probes = measureSqliteSchemaProbes(nativeWriter, () => {
          for (const statement of statements) {
            if (method === "iterate") {
              Array.from(statement.iterate());
            } else {
              statement[method]();
            }
          }
          return true;
        });
        expect(probes).toMatchObject({ schemaVersion: 100, userVersion: 100, dataVersion: 100 });
      }
    }
    if (typeof nativeWriter.setAuthorizer === "function") {
      let allowed = true;
      nativeWriter.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      const read = () =>
        entryCache.readSessionEntryCache(writer, { cache: true }).entries.get("agent:main:probe");
      const publications: Array<{
        prepared: ReturnType<typeof readPreparedSessionEntryChange>;
        sharing: ReturnType<typeof readPreparedSessionSharingChange>;
      }> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === "agent:main:probe") {
          publications.push({
            prepared: readPreparedSessionEntryChange(change, change.sessionKey),
            sharing: readPreparedSessionSharingChange(change),
          });
        }
      });
      try {
        expect(read()?.sessionId).toBe("probe");
        await withWrite((database) => writeProbe("current", database));
        expect(publications).toEqual([
          {
            prepared: expect.objectContaining({
              entry: expect.objectContaining({ sessionId: "probe", label: "current" }),
              source: expect.objectContaining({ filename: writer.path }),
            }),
            sharing: "unchanged",
          },
        ]);
        expect(read()?.label).toBe("current");
        allowed = false;
        expect(read).toThrow(/not authorized/i);
      } finally {
        stop();
        nativeWriter.setAuthorizer(null);
      }
      expect(read()?.label).toBe("current");
    }
  } finally {
    await broker.close();
    reader.database.close();
  }
});

it.each<{ scope: SessionEntryListScope; fullKeys: string[] }>([
  { scope: { cronRetention: { limit: 32 } }, fullKeys: cronKeys },
  {
    scope: { cronRetention: { limit: 1, afterSessionKey: cronKeys[0] } },
    fullKeys: [cronKeys[1]!],
  },
  { scope: { expiredCronRuns: { agentId: "main", updatedBefore: 2 } }, fullKeys: [cronKeys[0]!] },
  { scope: { expiredCronRuns: { agentId: "main", updatedBefore: 0 } }, fullKeys: [] },
])(
  "loads only selected cold snapshots outside the retention transaction: $scope",
  ({ scope, fullKeys }) => {
    const { database, options, read, select } = fixture();
    const saved = { prompt: "cron saved snapshot", skills: [] };
    const usageFamilySessionIds = Array.from({ length: 1024 }, (_, i) => `previous-run-${i}`);
    runOpenClawAgentWriteTransaction((db) => {
      for (const [index, sessionKey] of cronKeys.entries()) {
        writeSessionEntry(db, sessionKey, {
          sessionId: sessionKey,
          updatedAt: index === 1 ? 2 : 1,
          skillsSnapshot: saved,
          usageFamilySessionIds,
        });
      }
    }, options);
    read();
    const materialized: string[] = [];
    let hotPayloadBytes = 0;
    const nativeDb = requireNativeSqliteDatabase(database.db);
    const prepare = nativeDb.prepare.bind(nativeDb);
    vi.spyOn(nativeDb, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const observe = (row: Record<string, unknown>) => {
        if (typeof row.entry_json === "string") {
          hotPayloadBytes += Buffer.byteLength(row.entry_json);
        }
        if (typeof row.skills_snapshot_json === "string") {
          materialized.push(String(row.session_key));
        }
      };
      const all = statement.all.bind(statement);
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args);
        rows.forEach(observe);
        return rows;
      });
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        for (const row of iterate(...args)) {
          observe(row);
          yield row;
        }
        return undefined;
      });
      return statement;
    });
    const parse = JSON.parse;
    const decodedInTransaction: boolean[] = [];
    const savedJson = JSON.stringify(saved);
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text === savedJson) {
        decodedInTransaction.push(database.db.isTransaction);
      }
      return parse(text, reviver);
    });
    const entries = select(scope);
    expect(materialized.toSorted()).toEqual(fullKeys);
    expect(decodedInTransaction).toEqual(fullKeys.map(() => false));
    expect(
      entries.map(({ sessionKey, entry }) => ({ sessionKey, snapshot: entry.skillsSnapshot })),
    ).toEqual(fullKeys.map((sessionKey) => ({ sessionKey, snapshot: saved })));
    if (scope.cronRetention?.limit === 1) {
      // One page can read its hot payload twice, but must not hydrate its bloated siblings.
      expect(hotPayloadBytes).toBeLessThan(
        3 * Buffer.byteLength(JSON.stringify(usageFamilySessionIds)),
      );
    }
  },
);

function fixture(list = listSessionEntriesReadOnly) {
  const stateDir = tempDirs.make("selected-session-list-");
  const options = {
    agentId: "main",
    path: path.join(stateDir, "sessions.sqlite"),
    env: { OPENCLAW_STATE_DIR: stateDir },
  };
  const database = openOpenClawAgentDatabase(options);
  const write = (key: string, entry: Parameters<typeof writeSessionEntry>[2]) =>
    runOpenClawAgentWriteTransaction((db) => writeSessionEntry(db, key, entry), options);
  const storeJson = (key: string, json: string) =>
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(json, key);
  const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden" });
  runOpenClawAgentWriteTransaction((db) => {
    for (const name of ["c", "a", "b"]) {
      writeSessionEntry(db, `agent:main:${name}`, {
        sessionId: `session-${name}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved prompt", skills: [] },
      });
    }
    writeSessionEntry(db, hidden.sessionKey, { sessionId: hidden.sessionId, updatedAt: 1 });
  }, options);
  const scope = { agentId: options.agentId, env: options.env, storePath: options.path };
  const select = (selection: SessionEntryListScope) => list({ ...scope, ...selection });
  const read = (sessionKeys?: readonly string[]) => select({ projection: "list", sessionKeys });
  return { database, hidden, options, scope, read, select, write, storeJson };
}

it("reads cron participants only after expiry selection and includes committed changes", () => {
  const { database, scope: baseScope, select, write } = fixture();
  const sessionKey = "agent:main:cron:job:run:selected";
  const scope = { ...baseScope, sessionKey };
  const entry = {
    sessionId: "selected",
    updatedAt: 2,
    skillsSnapshot: { prompt: "retained deletion candidate", skills: [] },
  };
  write(sessionKey, entry);
  recordSessionParticipant(scope, { identity: { type: "agent", id: "before" }, promptedAt: 1 });
  const readExpired = () =>
    select({ ...scope, expiredCronRuns: { agentId: "main", updatedBefore: 2 } });
  const statements = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["participants"],
    (sql) => (/^select\b.*\bfrom "session_participants"/isu.test(sql) ? "participants" : null),
  );
  try {
    expect(readExpired()).toEqual([]);
    expect(statements.counts.participants).toBe(0);
  } finally {
    statements.restore();
  }
  write(sessionKey, { ...entry, updatedAt: 1 });
  recordSessionParticipant(scope, { identity: { type: "agent", id: "after" }, promptedAt: 2 });
  expect(readExpired()).toEqual([
    {
      sessionKey,
      entry: {
        ...entry,
        updatedAt: 1,
        delivery: { kind: "none" },
        participants: [
          { identity: { type: "agent", id: "before" } },
          { identity: { type: "agent", id: "after" } },
        ],
        participantCount: 2,
      },
    },
  ]);
});

it("retains unsplit snapshots on selected cron rows", () => {
  const { read, select, write, storeJson } = fixture();
  const sessionKey = "agent:main:cron:job:run:legacy";
  const entry = { sessionId: "legacy", updatedAt: 1 };
  write(sessionKey, entry);
  read();
  const retained = { ...entry, skillsSnapshot: { prompt: "retained raw prompt", skills: [] } };
  storeJson(sessionKey, JSON.stringify(retained));
  expect(select({ expiredCronRuns: { agentId: "main", updatedBefore: 2 } })).toEqual([
    { sessionKey, entry: retained },
  ]);
});

it.each(
  [listSessionEntriesReadOnly, listSessionEntriesCore].flatMap((list) =>
    [
      { selection: undefined, expected: ["a", "b", "c"] },
      { selection: ["c", "missing", "a", "c", "hidden", "malformed"], expected: ["a", "c"] },
      { selection: [], expected: [] },
    ].map(({ selection, expected }) => ({ list, selection, expected })),
  ),
)(
  "$list.name returns the ordered selected metadata for $selection",
  ({ list, selection, expected }) => {
    const { hidden, read, write, storeJson } = fixture(list);
    write("agent:main:malformed", { sessionId: "malformed", updatedAt: 1 });
    read();
    storeJson("agent:main:malformed", "{");
    const rows = read(
      selection?.map((name) => (name === "hidden" ? hidden.sessionKey : `agent:main:${name}`)),
    );
    expect(rows.map(({ sessionKey }) => sessionKey)).toEqual(
      expected.map((name) => `agent:main:${name}`),
    );
    expect(rows.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);
  },
);

it.each([false, true])(
  "rejects unrelated canonical-key corruption before selecting rows (delivery=%s)",
  (deliveryAlias) => {
    const { database, read, write, storeJson } = fixture();
    const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const key = deliveryAlias ? canonicalKey.toLowerCase() : "AGENT:MAIN:UNRELATED";
    const entry = { sessionId: deliveryAlias ? key : "unrelated", updatedAt: 1 };
    if (deliveryAlias) {
      write(key, entry);
    }
    read();
    if (deliveryAlias) {
      storeJson(
        key,
        JSON.stringify({
          ...entry,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!MixedCase:example.org" },
          }),
        }),
      );
    } else {
      database.db
        .prepare(
          "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES(?, ?, ?, ?, 1)",
        )
        .run(key, entry.sessionId, JSON.stringify(entry), 1);
    }
    markCanonicalSessionValidationPending(database, [key]);
    expect(() => read(deliveryAlias ? ["agent:main:a"] : [])).toThrow(
      deliveryAlias
        ? `non-canonical persisted row resolves to session key ${canonicalKey}`
        : "non-canonical persisted row",
    );
  },
);
