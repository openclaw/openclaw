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
      sessionKey: "agent:main:active",
      entry: {
        sessionId: "active",
        updatedAt: 2_000,
        lastInteractionAt: 3_000,
        lifecycleRevision: "active-revision-\ud800",
        worktree,
      },
    },
    {
      sessionKey: "agent:main:idle",
      entry: { sessionId: "idle", updatedAt: 1 },
    },
    {
      sessionKey: "agent:main:archived",
      entry: { sessionId: "archived", updatedAt: 10, archivedAt: 20 },
    },
  ];
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

it.each([
  { name: "unsettled row", payload: JSON.stringify({ sessionId: "owner", updatedAt: 1 }) },
  { name: "malformed JSON", payload: "{" },
  {
    name: "uncertified validity flag",
    payload: JSON.stringify({ sessionId: "owner", updatedAt: 1 }),
    validity: 1,
  },
  { name: "retained marker without a window", payload: "{}", validity: -1 },
])("refuses $name instead of authorizing cleanup", ({ payload, validity }) => {
  const scope = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: sessionDirs.make() },
    sessionKey: "agent:main:owner",
  };
  replaceSessionEntrySync(scope, { sessionId: "owner", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(scope);
  markCanonicalSessionValidationPending(database, [scope.sessionKey]);
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run(payload, scope.sessionKey);
  if (validity !== undefined) {
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?")
      .run(validity, scope.sessionKey);
  }
  if (validity === -1) {
    database.db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("owner");
  }
  expect(() => readSessionWorktreeOwnerFactsInDatabase(database, [scope.sessionKey])).toThrow();
});

it.each(["archived_at", "last_interaction_at"] as const)(
  "refuses a stale %s projection instead of changing the owner's classification",
  (column) => {
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: sessionDirs.make() },
      sessionKey: "agent:main:active-owner",
    };
    replaceSessionEntrySync(scope, {
      sessionId: "active-owner",
      updatedAt: 100,
      lastInteractionAt: 200,
    });
    const database = openOpenClawAgentDatabase(scope);
    // These projection-only writes do not invalidate canonical entry certification.
    database.db
      .prepare(`UPDATE session_nodes SET ${column} = 1 WHERE session_key = ?`)
      .run(scope.sessionKey);
    expect(() => readSessionWorktreeOwnerFactsInDatabase(database, [scope.sessionKey])).toThrow(
      "requires repair",
    );
  },
);

it("refuses a stale updatedAt projection on an otherwise valid row", () => {
  const scope = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: sessionDirs.make() },
    sessionKey: "agent:main:updated-owner",
  };
  replaceSessionEntrySync(scope, { sessionId: "updated-owner", updatedAt: 100 });
  runOpenClawAgentWriteTransaction((database) => {
    database.db
      .prepare("UPDATE session_nodes SET updated_at = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
  }, scope);
  expect(() =>
    readSessionWorktreeOwnerFactsInDatabase(openOpenClawAgentDatabase(scope), [scope.sessionKey]),
  ).toThrow("requires repair");
});

it("refuses duplicate custody members admitted by the logical JSON reader", () => {
  const scope = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: sessionDirs.make() },
    sessionKey: "agent:main:duplicate-custody",
  };
  replaceSessionEntrySync(scope, { sessionId: "duplicate-custody", updatedAt: 100 });
  runOpenClawAgentWriteTransaction((database) => {
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(
        '{"sessionId":"duplicate-custody","updatedAt":100,"lifecycleRevision":"old","lifecycleRevision":"current"}',
        scope.sessionKey,
      );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
  }, scope);
  expect(() =>
    readSessionWorktreeOwnerFactsInDatabase(openOpenClawAgentDatabase(scope), [scope.sessionKey]),
  ).toThrow("requires repair");
});
