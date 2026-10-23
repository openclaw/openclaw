import { expect, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { resolveSessionEntryCandidateTarget } from "./session-accessor.entry.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { resolveSessionEntry as resolveSessionEntrySelection } from "./session-accessor.sqlite-exact-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSessionTranscriptReadTarget } from "./session-accessor.transcript-target.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import { test } from "./session-entry-fixture.test-support.js";

test("ignores unrelated corrupt blobs in focused reads", async ({ store }) => {
  const { database, scope, sessionKey } = store;
  const { storePath } = scope;
  const selected = { sessionId: "focused-session", model: "target" };
  await upsertSessionEntryCore(scope, { ...selected, updatedAt: 42 });
  for (const [childSessionKey, lineage] of [
    ["agent:main:focused-both-child", { spawnedBy: sessionKey }],
    ["agent:main:focused-parent-child", { parentSessionKey: sessionKey }],
    [
      "agent:main:focused-spawned-child",
      { parentSessionKey: "agent:main:other-parent", spawnedBy: sessionKey },
    ],
  ] as const) {
    await upsertSessionEntryCore(
      { ...scope, sessionKey: childSessionKey },
      { ...lineage, sessionId: childSessionKey, updatedAt: 43 },
    );
    recordSessionParticipant(
      { ...scope, sessionKey: childSessionKey },
      { identity: { type: "agent", id: childSessionKey }, promptedAt: 43 },
    );
  }
  // Admit the reader before injecting an unrelated corrupt row.
  expect(loadSessionEntry(scope)?.sessionId).toBe("focused-session");
  const unrelatedEntryJson = "{ unrelated, intentionally invalid JSON";
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("agent:main:unrelated-session", "unrelated-session", unrelatedEntryJson, 1);

  const parse = vi.spyOn(JSON, "parse");
  let restoreParticipants = () => {};
  try {
    for (const count of [1, 2]) {
      expect(loadSessionEntry(scope)).toMatchObject(selected);
      expect(
        parse.mock.calls.filter(
          ([json]) =>
            typeof json === "string" &&
            json.includes('"sessionId":"focused-session"') &&
            json.includes('"model":"target"'),
        ),
      ).toHaveLength(count);
    }
    const participantReads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["participants"],
      (sql) => (sql.includes('from "session_participants"') ? "participants" : null),
    );
    restoreParticipants = participantReads.restore;
    const children = await listSessionChildEntriesReadOnly(scope);
    expect(children.map((child) => child.sessionKey)).toEqual([
      "agent:main:focused-both-child",
      "agent:main:focused-parent-child",
      "agent:main:focused-spawned-child",
    ]);
    for (const { sessionKey: childKey, entry } of children) {
      expect({
        participants: entry.participants,
        participantCount: entry.participantCount,
      }).toEqual({
        participants: [{ identity: { type: "agent", id: childKey } }],
        participantCount: 1,
      });
    }
    expect(participantReads.counts.participants).toBeLessThanOrEqual(1);
    expect(resolveSessionEntrySelection(scope)).toMatchObject({
      existing: { sessionId: "focused-session" },
      legacyKeys: [],
      normalizedKey: sessionKey,
    });
    expect(
      resolveSessionEntryCandidateTarget({
        agentId: "main",
        candidateKeys: [sessionKey],
        cfg: { session: { store: storePath } },
      }),
    ).toMatchObject({ sessionKey, entry: { sessionId: "focused-session" }, persisted: true });
    const transcript = resolveSessionTranscriptReadTarget({
      ...scope,
      sessionId: "focused-session",
    });
    expect(transcript).toMatchObject({ agentId: "main", sessionId: "focused-session", sessionKey });
    expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
  } finally {
    restoreParticipants();
    parse.mockRestore();
  }
});
