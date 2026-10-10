import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, expect, it, vi, describe } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { listSessionEntriesCore, listSessionEntriesReadOnly } from "./session-accessor.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as identityPublication from "./session-accessor.sqlite-identity.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  measureSessionSchemaProbes,
  measureSqliteSchemaProbes,
  type SessionProbeOperations,
} from "./session-accessor.sqlite-schema-probes.test-support.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

it("publishes native writes into a warm cache without new generation probes", () => {
  const options = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-publication-probes-") },
  };
  const writer = openOpenClawAgentDatabase(options);
  entryCache.readSessionEntryCache(writer, { cache: true });
  const sql = observeHostDataSql();
  const publicationQueries: string[] = [];
  const observePublication = <T>(publish: () => T): T => {
    const start = sql.queries.length;
    try {
      return publish();
    } finally {
      publicationQueries.push(
        ...sql.queries
          .slice(start)
          .filter((query) => query.includes("openclaw_session_nodes_cache_generation")),
      );
    }
  };
  const publishEntry = entryCache.publishSessionEntryCacheInvalidation;
  const cachePublication = vi
    .spyOn(entryCache, "publishSessionEntryCacheInvalidation")
    .mockImplementation((...args) => observePublication(() => publishEntry(...args)));
  const publishIdentity = identityPublication.prepareSessionIdentityPublication;
  const lifecyclePublication = vi
    .spyOn(identityPublication, "prepareSessionIdentityPublication")
    .mockImplementation((...args) => observePublication(() => publishIdentity(...args)));
  const replacementKey = "agent:main:publication-replacement";
  const initialKey = "agent:main:publication-initial";
  try {
    replaceSessionEntrySync(
      { ...options, storePath: writer.path, sessionKey: replacementKey },
      { sessionId: "publication-replacement", updatedAt: 1, label: "replacement" },
    );
    expect(
      ensureSessionEntrySync(
        { ...options, storePath: writer.path, sessionKey: initialKey },
        { sessionId: "publication-initial", updatedAt: 1, label: "initial" },
      ),
    ).toBe(true);
    expect(cachePublication).toHaveBeenCalled();
    expect(lifecyclePublication).toHaveBeenCalled();
    expect(publicationQueries).toEqual([]);
    expect(readExactSessionEntryRow(writer, replacementKey)?.entry.label).toBe("replacement");
    expect(readExactSessionEntryRow(writer, initialKey)?.entry.label).toBe("initial");
  } finally {
    lifecyclePublication.mockRestore();
    cachePublication.mockRestore();
    sql.restore();
  }
});

it("refreshes admitted session readers after worker commits without schema or freshness probes", async () => {
  const options = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-schema-probes-") },
  };
  const writer = openOpenClawAgentDatabase(options);
  writeSessionEntry(writer, "agent:main:probe", { sessionId: "probe", updatedAt: 1 });
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  if (!reader.found) {
    throw new Error("Session probe reader is missing");
  }
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
    console.log(JSON.stringify(results));
    for (const result of Object.values(results).flatMap(Object.values)) {
      expect(result.admitted).toBe(true);
      expect(result.schemaVersion).toBe(0);
      expect(result.userVersion).toBe(0);
      expect(result.dataVersion).toBe(0);
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
      expect(result).toMatchObject({
        admitted: true,
        schemaVersion: 0,
        userVersion: 0,
        dataVersion: 0,
      });
    }
    // Exercise both native execution paths with statements retained before observation.
    const probeGroups = [
      ["schema_version", "user_version", "data_version"].map((name) =>
        writer.db.prepare(`PRAGMA ${name}`),
      ),
      [
        writer.db.prepare(`SELECT schema_version, user_version, data_version
          FROM main.pragma_schema_version(), main.pragma_user_version(), main.pragma_data_version()`),
      ],
    ];
    for (const statements of probeGroups) {
      for (const method of ["get", "all", "iterate"] as const) {
        const probes = measureSqliteSchemaProbes(writer.db, () => {
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
    if (typeof writer.db.setAuthorizer === "function") {
      let allowed = true;
      writer.db.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
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
        writeSessionEntry(writer, "agent:main:probe", {
          sessionId: "probe",
          updatedAt: 1,
          label: "current",
        });
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
        writer.db.setAuthorizer(null);
      }
      expect(read()?.label).toBe("current");
    }
  } finally {
    await broker.close();
    reader.database.close();
  }
});

it.each<{
  scope: SessionEntryListScope;
  fullKeys: string[];
}>(
  (
    [
      { cronRetention: true },
      { expiredCronRuns: { agentId: "main", updatedBefore: 2 } },
      { expiredCronRuns: { agentId: "main", updatedBefore: 0 } },
    ] satisfies SessionEntryListScope[]
  ).map((scope) => ({
    scope,
    fullKeys: scope.cronRetention
      ? [
          "agent:main:cron:job:run:old",
          "agent:main:cron:job:run:recent",
          "agent:other:cron:job:run:old",
        ]
      : scope.expiredCronRuns?.updatedBefore === 2
        ? ["agent:main:cron:job:run:old"]
        : [],
  })),
)(
  "loads only selected cold snapshots outside the retention transaction: $scope",
  ({ scope, fullKeys }) => {
    const { database, options, read } = fixture(listSessionEntriesReadOnly);
    const saved = { prompt: "cron saved snapshot", skills: [] };
    runOpenClawAgentWriteTransaction((db) => {
      for (const [sessionKey, updatedAt] of [
        ["agent:main:cron:job:run:old", 1],
        ["agent:main:cron:job:run:recent", 2],
        ["agent:other:cron:job:run:old", 1],
      ] as const) {
        writeSessionEntry(db, sessionKey, {
          sessionId: sessionKey,
          updatedAt,
          skillsSnapshot: saved,
        });
      }
    }, options);
    read();
    const materialized: string[] = [];
    const prepare = database.db.prepare.bind(database.db);
    vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const observe = (row: Record<string, unknown>) => {
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
    const entries = listSessionEntriesReadOnly({
      agentId: "main",
      storePath: options.path,
      env: options.env,
      ...scope,
    });
    expect(materialized.toSorted()).toEqual(fullKeys);
    expect(decodedInTransaction).toEqual(fullKeys.map(() => false));
    expect(
      entries.filter(({ entry }) => entry.skillsSnapshot).map(({ sessionKey }) => sessionKey),
    ).toEqual(fullKeys);
    for (const { entry } of entries.filter(({ entry: candidate }) => candidate.skillsSnapshot)) {
      expect(entry.skillsSnapshot).toEqual(saved);
    }
    expect(entries.map(({ sessionKey }) => sessionKey)).toEqual(fullKeys);
  },
);

function fixture(list: typeof listSessionEntriesReadOnly) {
  const stateDir = tempDirs.make("selected-session-list-");
  const options = {
    agentId: "main",
    path: path.join(stateDir, "sessions.sqlite"),
    env: { OPENCLAW_STATE_DIR: stateDir },
  };
  const database = openOpenClawAgentDatabase(options);
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
  const read = (sessionKeys?: readonly string[]) =>
    list({
      agentId: options.agentId,
      env: options.env,
      storePath: options.path,
      projection: "list",
      sessionKeys,
    });
  return { database, hidden, options, read };
}

it("retains unsplit snapshots on selected cron rows", () => {
  const { database, options, read } = fixture(listSessionEntriesReadOnly);
  const sessionKey = "agent:main:cron:job:run:legacy";
  const entry = { sessionId: "legacy", updatedAt: 1 };
  runOpenClawAgentWriteTransaction((db) => writeSessionEntry(db, sessionKey, entry), options);
  read();
  const retained = { ...entry, skillsSnapshot: { prompt: "retained raw prompt", skills: [] } };
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run(JSON.stringify(retained), sessionKey);
  expect(
    listSessionEntriesReadOnly({
      agentId: "main",
      storePath: options.path,
      env: options.env,
      expiredCronRuns: { agentId: "main", updatedBefore: 2 },
    }),
  ).toEqual([{ sessionKey, entry: retained }]);
});

describe.each([
  { mode: "readonly", list: listSessionEntriesReadOnly },
  { mode: "core", list: listSessionEntriesCore },
])("selected $mode listing", ({ list }) => {
  it.each([
    { selection: undefined, expected: ["a", "b", "c"] },
    { selection: ["c", "missing", "a", "c", "hidden", "malformed"], expected: ["a", "c"] },
    { selection: [], expected: [] },
  ])("returns the ordered selected metadata for $selection", ({ selection, expected }) => {
    const { database, hidden, options, read } = fixture(list);
    runOpenClawAgentWriteTransaction((db) => {
      writeSessionEntry(db, "agent:main:malformed", { sessionId: "malformed", updatedAt: 1 });
    }, options);
    read();
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run("{", "agent:main:malformed");
    const rows = read(
      selection?.map((name) => (name === "hidden" ? hidden.sessionKey : `agent:main:${name}`)),
    );
    expect(rows.map(({ sessionKey }) => sessionKey)).toEqual(
      expected.map((name) => `agent:main:${name}`),
    );
    expect(rows.every(({ entry }) => entry.skillsSnapshot === undefined)).toBe(true);
  });
});

it("retains unrelated canonical-key errors for an empty selection", () => {
  const { database, read } = fixture(listSessionEntriesReadOnly);
  read();
  // Explicitly pending repair rows must not disappear behind an unrelated selection.
  database.db
    .prepare(
      "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES(?, ?, ?, ?, 1)",
    )
    .run(
      "AGENT:MAIN:UNRELATED",
      "unrelated",
      JSON.stringify({ sessionId: "unrelated", updatedAt: 1 }),
      1,
    );
  markCanonicalSessionValidationPending(database, ["AGENT:MAIN:UNRELATED"]);
  expect(() => read([])).toThrow("non-canonical persisted row");
});

it("validates unrelated warm delivery aliases before selecting listing keys", () => {
  const { database, options, read } = fixture(listSessionEntriesReadOnly);
  const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
  const legacyKey = canonicalKey.toLowerCase();
  runOpenClawAgentWriteTransaction((db) => {
    writeSessionEntry(db, legacyKey, { sessionId: legacyKey, updatedAt: 1 });
  }, options);
  read();
  const entry = {
    sessionId: legacyKey,
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({
      context: { channel: "matrix", to: "!MixedCase:example.org" },
    }),
  };
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run(JSON.stringify(entry), legacyKey);
  markCanonicalSessionValidationPending(database, [legacyKey]);
  expect(() => read(["agent:main:a"])).toThrow(
    `non-canonical persisted row resolves to session key ${canonicalKey}`,
  );
});
