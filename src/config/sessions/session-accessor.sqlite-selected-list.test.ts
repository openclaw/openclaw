import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveInternalSessionEffectsIdentity } from "./internal-session-key.js";
import { listSessionEntriesCore, listSessionEntriesReadOnly } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
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
    expect(entries).toHaveLength(scope.cronRetention ? 6 : fullKeys.length);
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

  it.each([{ selection: [] }, { selection: ["agent:main:a"] }])(
    "retains unrelated canonical-key errors when selecting $selection",
    ({ selection }) => {
      const { database, read } = fixture(list);
      read();
      // Raw DML after validation must not disappear behind an unrelated selection.
      database.db
        .prepare(
          "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at) VALUES(?, ?, ?, ?)",
        )
        .run(
          "AGENT:MAIN:UNRELATED",
          "unrelated",
          JSON.stringify({ sessionId: "unrelated", updatedAt: 1 }),
          1,
        );
      expect(() => read(selection)).toThrow("non-canonical persisted row");
    },
  );

  it("validates unrelated warm delivery aliases before selecting listing keys", () => {
    const { database, options, read } = fixture(list);
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
    expect(() => read(["agent:main:a"])).toThrow(
      `non-canonical persisted row resolves to session key ${canonicalKey}`,
    );
  });
});
