import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import {
  readExactSessionEntryRow,
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import {
  projectSessionEntryLifecycleMutation,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { readSessionMaintenanceCapCandidates } from "./session-accessor.sqlite-maintenance-candidates.js";
import { deriveSessionPredicateColumns } from "./session-predicate-columns.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture(encoding?: "UTF-8" | "UTF-16le" | "UTF-16be") {
  const stateDir = tempDirs.make("openclaw-excluded-rows-");
  const pathname = path.join(stateDir, "agent.sqlite");
  if (encoding) {
    const seed = new DatabaseSync(pathname);
    try {
      seed.exec(
        `PRAGMA encoding='${encoding}'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;`,
      );
    } finally {
      seed.close();
    }
  }
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    path: pathname,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const put = (key: string, id: string, json?: string | Buffer) => {
    const entryJson = json ?? JSON.stringify({ sessionId: id, updatedAt: 1 });
    const columns = deriveSessionPredicateColumns(
      typeof entryJson === "string" ? entryJson : entryJson.toString("utf8"),
    );
    database.db
      .prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at, session_started_at, has_optional_references)
      VALUES (?, ?, CAST(? AS TEXT), ?, ?, ?)`)
      .run(key, id, entryJson, 1, columns.session_started_at, columns.has_optional_references);
  };
  return {
    database,
    put,
    seed: (keys: string[], prefix = "id-") =>
      keys.forEach((key, index) => put(key, `${prefix}${index}`)),
    refs: (excluded?: ReadonlySet<string>, candidates?: string[]) =>
      readReferencedSessionIds(database, excluded, candidates),
    cap: (excludedKeys: ReadonlySet<string> = new Set()) =>
      readSessionMaintenanceCapCandidates({
        database,
        activeSessionKeys: [],
        overflow: Number.MAX_SAFE_INTEGER,
        excludedKeys,
        readPreserveKeys: () => undefined,
      }).store,
    putFields: (fields: string) =>
      put("owner", "current", `{"sessionId":"current","updatedAt":1,${fields}}`),
    plan: (
      removals: Parameters<typeof projectSessionEntryLifecycleMutation>[1]["removals"],
      upserts: Parameters<typeof projectSessionEntryLifecycleMutation>[1]["upserts"] = [],
    ) =>
      projectSessionEntryLifecycleMutation(
        { agentId: database.agentId, path: database.path },
        {
          archiveDirectory: path.dirname(database.path),
          removals,
          upserts,
        },
      ),
  };
}

function trackMaterializedKeys(database: OpenClawAgentDatabase) {
  const materializedKeys: string[] = [];
  const nativeDb = requireNativeSqliteDatabase(database.db);
  const prepare = nativeDb.prepare.bind(nativeDb);
  vi.spyOn(nativeDb, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
      for (const row of iterate(...args)) {
        if (typeof row.session_key === "string") {
          materializedKeys.push(row.session_key);
        }
        yield row;
      }
      return undefined;
    });
    return statement;
  });
  return materializedKeys;
}

describe("SQLite exclusions and candidate reference reads", () => {
  it.each(["UTF-8", "UTF-16le"] as const)(
    "preserves exact exclusions across %s text conversion",
    (encoding) => {
      const { database, seed, cap } = fixture(encoding);
      const read = (excluded: ReadonlySet<string>) =>
        Object.values(cap(excluded)).map((entry) => entry.sessionId);
      const keys = ["agent:main:\uFFFD", "agent:main:a\uFFFE", "agent:main:b\uFFFF", "ordinary"];
      seed(keys);
      expect(database.db.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      const excluded = new Set(["agent:main:\uFFFE", "agent:main:\uFFFF", ...keys.slice(1)]);
      expect(read(excluded).toSorted()).toEqual(
        encoding === "UTF-8" ? ["id-0"] : ["id-0", "id-1", "id-2"],
      );
      const storedKeys = database.db.prepare("SELECT session_key FROM session_nodes").all();
      expect(read(new Set(storedKeys.map((row) => String(row.session_key))))).toEqual([]);
    },
  );

  it("preserves exact UTF-16 membership without replacing unmatched surrogates", () => {
    const { seed, cap } = fixture();
    const keys = ["\uFFFD", "\uD83E\uDD9E", "quoted'key", "日本語"];
    seed(keys);
    const excluded = new Set(["\uD800", "\uDC00", ...keys.slice(1)]);
    expect(Object.values(cap(excluded)).map((entry) => entry.sessionId)).toEqual(["id-0"]);
  });
  it("preserves raw UTF-8 noncharacters in metadata and prompt projections", () => {
    const { database, put, refs, cap } = fixture("UTF-8");
    const key = "agent:main:survivor";
    const prompt = "unused saved prompt".repeat(32);
    const json = JSON.stringify({
      sessionId: "raw",
      updatedAt: 1,
      previousSessionId: "historical",
      label: "\uFFFE\uFFFF",
    });
    put(key, "raw", Buffer.from(json));
    database.db
      .prepare(
        "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?)",
      )
      .run(key, JSON.stringify({ prompt, skills: [] }));
    const storedBytes = database.db.prepare("SELECT hex(entry_json) AS bytes FROM session_nodes");
    const bytesBefore = storedBytes.get()?.bytes;
    const full = readSessionEntryStore(database, { allowCanonicalRepair: true });
    expect(full[key]).toBeDefined();
    const metadata = { ...full[key] };
    delete metadata.skillsSnapshot;
    expect(cap()).toEqual({ [key]: metadata });
    expect([...refs()].toSorted()).toEqual(["historical", "raw"]);
    expect(refs(undefined, ["historical"])).toEqual(new Set(["historical"]));
    expect(refs(undefined, ["raw"])).toEqual(new Set(["raw"]));
    expect(readSessionEntryCount(database)).toBe(1);
    expect([...iterateSessionEntryKeys(database)]).toEqual([key]);
    const listed = readExactSessionEntryRow(database, key, "list");
    expect(listed?.entry).toEqual(metadata);
    expect(listed?.row.entry_json).not.toContain(prompt);
    expect(cap(new Set([key]))).toEqual({});
    expect([...refs(new Set([key]))]).toEqual([]);
    expect(storedBytes.get()?.bytes).toBe(bytesBefore);
  });

  it("preserves raw IDs but rejects a non-finite timestamp", () => {
    const json = '{"sessionId":"raw","updatedAt":1e999}';
    const { database, put, refs, cap } = fixture();
    const key = "agent:main:survivor";
    readSessionEntryCache(database, { cache: false });
    put(key, "raw", json);
    const snapshot = readSessionEntryCache(database, { cache: false });
    expect(snapshot.keys).toEqual([key]);
    expect(snapshot.entries).toEqual(new Map());
    expect(readSessionEntryCount(database)).toBe(0);
    expect([...iterateSessionEntryKeys(database)]).toEqual([]);
    put("excluded", "excluded");
    const excludedKeys = new Set(["excluded"]);
    expect([...refs(excludedKeys)]).toEqual(["raw"]);
    expect(refs(excludedKeys, ["raw"])).toEqual(new Set(["raw"]));
    expect(cap(excludedKeys)).toEqual({});
  });
  it("bounds reference rows when planning removal among 5,000 unrelated entries", async () => {
    const { database, put, refs, plan } = fixture();
    const removedKey = "agent:main:removed";
    const entry = { sessionId: "removed", updatedAt: 1, previousSessionId: "shared" };
    runSqliteImmediateTransactionSync(database.db, () => {
      for (let index = 0; index < 5_000; index += 1) {
        put(`agent:main:unrelated-${index}`, `unrelated-${index}`);
      }
      put(removedKey, entry.sessionId, JSON.stringify(entry));
      put("agent:main:survivor", "shared");
      database.db.exec("UPDATE session_nodes SET entry_valid = 1");
    });
    // Admit the fixture before measuring the hot lifecycle planning path.
    readSessionEntryStore(database);
    const fullReferences = refs(new Set([removedKey]));
    const keys = trackMaterializedKeys(database);
    const result = await plan([{ sessionKey: removedKey, expectedEntry: entry }]);
    expect(result.removals).toHaveLength(1);
    expect(result.deletePlans.map((item) => item.sessionId)).toEqual(
      [entry.sessionId, entry.previousSessionId].filter((id) => !fullReferences.has(id)),
    );
    expect(result.deletePlans.map((item) => item.sessionId)).toEqual(["removed"]);
    expect(keys.length).toBeLessThan(50);
  });

  it("preserves surviving and same-call references to generations absent from the removed entry", async () => {
    const { database, put, plan } = fixture();
    const removedKey = "agent:main:removed";
    put(removedKey, "removed");
    put("agent:main:survivor", "retained-history");
    database.db.exec("UPDATE session_nodes SET entry_valid = 1");
    const insertWindow = database.db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    );
    for (const id of ["retained-history", "upsert-history", "unreferenced-history"]) {
      insertWindow.run(id, removedKey);
    }
    const result = await plan(
      [{ sessionKey: removedKey, archiveRemovedTranscript: true }],
      [
        {
          sessionKey: "agent:main:new-owner",
          entry: { sessionId: "upsert-history", updatedAt: 2 },
        },
      ],
    );
    expect(result.deletePlans.map((item) => item.sessionId).toSorted()).toEqual([
      "removed",
      "unreferenced-history",
    ]);
  });

  it("protects duplicate checkpoint references using the entry parser", () => {
    const fields =
      '"compactionCheckpoints":[{"sessionId":"wrong","sessionId":"candidate","preCompaction":{},"postCompaction":{}}]';
    const { putFields, refs } = fixture();
    putFields(fields);
    expect(refs(undefined, ["candidate"])).toEqual(new Set(["candidate"]));
    expect(refs(new Set(["owner"]), ["candidate"])).toEqual(new Set());
  });

  it.each([
    '"usageFamilySessionIds":[1]',
    '"compactionCheckpoints":[{}]',
    '"compactionCheckpoints":[{"preCompaction":{"sessionFile":1},"postCompaction":{}}]',
    '"compactionCheckpoints":[{"preCompaction":{},"postCompaction":{"sessionFile":1}}]',
    '"compactionCheckpoints":[{"preCompaction":{},"postCompaction":{"entryId":1}}]',
  ])("retains parser failures for malformed references: %s", (fields) => {
    const { putFields, refs } = fixture();
    putFields(fields);
    expect(() => refs(undefined, ["candidate"])).toThrow(TypeError);
    expect(refs(new Set(["owner"]), ["candidate"])).toEqual(new Set());
  });

  it("preserves exact excluded-key membership for UTF-16 candidates", () => {
    const { database, seed, refs } = fixture("UTF-16be");
    const keys = ["nul\0tail", "a\uFFFE", "b\uFFFF", "c\uFFFD", "日本語🦞"];
    seed(keys, "current-");
    const returned = database.db
      .prepare("SELECT session_key, current_session_id FROM session_nodes")
      .all();
    for (const row of returned) {
      const candidate = String(row.current_session_id);
      const excluded = new Set(keys);
      expect(refs(excluded, [candidate])).toEqual(
        new Set(excluded.has(String(row.session_key)) ? [] : [candidate]),
      );
    }
  });
});
