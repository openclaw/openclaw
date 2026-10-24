import { afterAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { readSessionWorktreeOwnerFactsInDatabase } from "./session-accessor.sqlite-worktree-owner.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { readExactSessionEntriesWithLifecycle } from "./session-entry-read.worker.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-worktree-owner-facts-");

function ownerFixture(
  sessionId = "owner",
  overrides: { updatedAt?: number; lastInteractionAt?: number } = {},
) {
  const scope = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: sessionDirs.make() },
    sessionKey: `agent:main:${sessionId}`,
  };
  replaceSessionEntrySync(scope, { sessionId, updatedAt: 100, ...overrides });
  const database = openOpenClawAgentDatabase(scope);
  const update = (column: string, value: string | number) =>
    database.db
      .prepare(`UPDATE session_nodes SET ${column} = ? WHERE session_key = ?`)
      .run(value, scope.sessionKey);
  return {
    scope,
    database,
    update,
    read: () => readSessionWorktreeOwnerFactsInDatabase(database, [scope.sessionKey]),
    write: (run: () => void) => runOpenClawAgentWriteTransaction(run, scope),
  };
}

it("reads GC owner facts without parsing unrelated session payloads", () => {
  const scope = { agentId: "main", env: { OPENCLAW_STATE_DIR: sessionDirs.make() } };
  const payloadMarker = "unrelated-worktree-owner-context";
  const worktree = {
    id: "worktree-active",
    branch: "session-active",
    repoRoot: "/synthetic/repository",
    canonicalWorkspaceDir: "/synthetic/workspace",
  };
  const entries = [
    {
      sessionId: "active",
      updatedAt: 2_000,
      lastInteractionAt: 3_000,
      lifecycleRevision: "active-revision-\ud800",
      worktree,
    },
    { sessionId: "idle", updatedAt: 1 },
    { sessionId: "archived", updatedAt: 10, archivedAt: 20 },
  ].map((entry) => ({ sessionKey: `agent:main:${entry.sessionId}`, entry }));
  for (const { sessionKey, entry } of entries) {
    replaceSessionEntrySync(
      { ...scope, sessionKey },
      { ...entry, label: payloadMarker.repeat(4_096) },
    );
  }
  const retainedKey = "agent:main:retained";
  runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptSessionRoot(
      database,
      { ...resolveSqliteScope({ ...scope, sessionKey: retainedKey }), sessionId: "retained" },
      1,
    );
  }, scope);
  const database = openOpenClawAgentDatabase(scope);
  const parseJson = JSON.parse;
  const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text.includes(payloadMarker)) {
      throw new Error("GC parsed an unrelated full session payload");
    }
    return parseJson(text, reviver);
  });
  const sql = observeHostDataSql();
  try {
    const result = readExactSessionEntriesWithLifecycle({
      kind: "session-exact-entries",
      database: { agentId: database.agentId, path: database.path },
      env: scope.env,
      projection: "worktree",
      sessionKeys: [
        ...entries.map(({ sessionKey }) => sessionKey),
        retainedKey,
        "agent:main:missing",
      ],
    });
    expect(result.entries.toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey))).toEqual(
      entries.toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey)),
    );
    expect(
      sql.queries.filter((query) => /^(BEGIN|COMMIT|SAVEPOINT|RELEASE)\b/i.test(query)),
    ).toEqual([]);
  } finally {
    sql.restore();
    parse.mockRestore();
  }
});

const ownerJson = JSON.stringify({ sessionId: "owner", updatedAt: 1 });
it.each([
  ["unsettled row", ownerJson, undefined],
  ["malformed JSON", "{", undefined],
  ["uncertified validity flag", ownerJson, 1],
  ["retained marker without a window", "{}", -1],
] as const)("refuses %s instead of authorizing cleanup", (_name, payload, validity) => {
  const { scope, database, update, read } = ownerFixture("owner", { updatedAt: 1 });
  markCanonicalSessionValidationPending(database, [scope.sessionKey]);
  update("entry_json", payload);
  if (validity !== undefined) {
    update("entry_valid", validity);
  }
  if (validity === -1) {
    database.db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("owner");
  }
  expect(read).toThrow();
});

it.each(["archived_at", "last_interaction_at"] as const)(
  "refuses a stale %s projection instead of changing the owner's classification",
  (column) => {
    const { update, read } = ownerFixture("active-owner", { lastInteractionAt: 200 });
    update(column, 1);
    expect(read).toThrow("requires repair");
  },
);

it.each([
  ["updated-owner", "updated_at", 1],
  [
    "duplicate-custody",
    "entry_json",
    '{"sessionId":"duplicate-custody","updatedAt":100,"lifecycleRevision":"old","lifecycleRevision":"current"}',
  ],
] as const)("refuses corrupt %s state even when certified", (sessionId, column, value) => {
  const { update, read, write } = ownerFixture(sessionId);
  write(() => {
    update(column, value);
    update("entry_valid", 1);
  });
  expect(read).toThrow("requires repair");
});
