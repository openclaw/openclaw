import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveSessionEntryCandidateTarget } from "./session-accessor.entry.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { resolveSessionEntry as resolveSessionEntrySelection } from "./session-accessor.sqlite-exact-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSessionTranscriptReadTarget } from "./session-accessor.transcript-target.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-focused-reads-");

it("does not parse unrelated blobs across focused child, candidate, and transcript reads", async () => {
  const storePath = path.join(tempDirs.make(), "sessions.json");
  const sessionKey = "agent:main:focused-session";
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId: "focused-session", updatedAt: 42 },
  );
  for (const [childSessionKey, lineage] of [
    ["agent:main:focused-both-child", { spawnedBy: sessionKey }],
    ["agent:main:focused-parent-child", { parentSessionKey: sessionKey }],
    [
      "agent:main:focused-spawned-child",
      { parentSessionKey: "agent:main:other-parent", spawnedBy: sessionKey },
    ],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: childSessionKey, storePath },
      { ...lineage, sessionId: childSessionKey, updatedAt: 43 },
    );
    recordSessionParticipant(
      { agentId: "main", sessionKey: childSessionKey, storePath },
      { identity: { type: "agent", id: childSessionKey }, promptedAt: 43 },
    );
  }
  const databasePath = expectDefined(
    resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    "focused session database path",
  );
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  // Admit the reader before injecting an unrelated corrupt row.
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.sessionId).toBe(
    "focused-session",
  );
  const unrelatedEntryJson = "{ unrelated, intentionally invalid JSON";
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("agent:main:unrelated-session", "unrelated-session", unrelatedEntryJson, 1);

  const parse = vi.spyOn(JSON, "parse");
  const participantReads = trackSqliteStatementExecutions(database.db, ["participants"], (sql) =>
    sql.includes('from "session_participants"') ? "participants" : null,
  );
  try {
    const children = await listSessionChildEntriesReadOnly({
      agentId: "main",
      sessionKey,
      storePath,
    });
    expect(children.map((child) => child.sessionKey)).toEqual([
      "agent:main:focused-both-child",
      "agent:main:focused-parent-child",
      "agent:main:focused-spawned-child",
    ]);
    expect(
      children.map(({ sessionKey: childKey, entry }) => ({
        sessionKey: childKey,
        participants: entry.participants,
        participantCount: entry.participantCount,
      })),
    ).toEqual(
      children.map(({ sessionKey: childKey }) => ({
        sessionKey: childKey,
        participants: [{ identity: { type: "agent", id: childKey } }],
        participantCount: 1,
      })),
    );
    expect(participantReads.counts.participants).toBeLessThanOrEqual(1);
    expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
    expect(resolveSessionEntrySelection({ agentId: "main", sessionKey, storePath })).toMatchObject({
      existing: { sessionId: "focused-session" },
      legacyKeys: [],
      normalizedKey: sessionKey,
    });
    expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
    expect(
      resolveSessionEntryCandidateTarget({
        agentId: "main",
        candidateKeys: [sessionKey],
        cfg: { session: { store: storePath } },
      }),
    ).toMatchObject({ sessionKey, entry: { sessionId: "focused-session" }, persisted: true });
    expect(
      resolveSessionTranscriptReadTarget({
        agentId: "main",
        sessionId: "focused-session",
        sessionKey,
        storePath,
      }),
    ).toMatchObject({ agentId: "main", sessionId: "focused-session", sessionKey });
    expect(parse.mock.calls.filter(([value]) => value === unrelatedEntryJson)).toHaveLength(0);
  } finally {
    participantReads.restore();
    parse.mockRestore();
  }
});
