import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import { createSessionTranscriptTurnKernel } from "./session-turn.kernel.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-turn-count-");
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each([1, 4, 513])(
  "batches %i fresh messages while preserving strict window advances",
  (count) => {
    const sessionId = `turn-${count}`;
    const sessionKey = `agent:main:${sessionId}`;
    const scope = { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const resolved = resolveSqliteTranscriptScope(scope);
    const databaseOptions = toDatabaseOptions(resolved);
    const database = openOpenClawAgentDatabase(databaseOptions);
    const select = (columns: string) =>
      database.db
        .prepare(`SELECT ${columns} FROM session_windows WHERE session_id = ?`)
        .get(scope.sessionId);
    const fresh = Array.from({ length: count }, (_, index) => ({
      eventId: `fresh-${index}`,
      parentId: index ? `fresh-${index - 1}` : "seed",
      message: { role: index % 2 ? "assistant" : "user", content: `Message ${index}` },
    }));
    const kernel = createSessionTranscriptTurnKernel(resolved, {
      expectedSessionId: scope.sessionId,
      sessionFile: scope.sessionKey,
      keyFormat: "agent-qualified",
      messages: [],
    });
    let authority: SessionTranscriptAuthority | undefined;
    const commit = (messages: { eventId: string; message: { role: string; content: string } }[]) =>
      runOpenClawAgentWriteTransaction((db) => {
        const result = kernel.commit(db, messages).result;
        const fact = readStagedSessionTranscriptAuthority(db)?.[0]?.facts.get(scope.sessionKey);
        authority = fact?.kind === "postimage" ? fact.value : undefined;
        return result;
      }, databaseOptions);
    commit([{ eventId: "seed", message: { role: "assistant", content: "Existing history" } }]);
    database.db
      .prepare(
        "UPDATE session_windows SET transcript_updated_at = ?, transcript_observed_at = ? WHERE session_id = ?",
      )
      .run(10000, 20000, scope.sessionId);
    vi.spyOn(Date, "now").mockReturnValue(5000);
    let statements = 0;
    const events = channel("openclaw.database.statement");
    const observe = (value: unknown) => {
      const event = value as { engine: string; sql?: string; outcome: string };
      if (event.engine === "sqlite" && event.outcome === "ok") {
        statements += event.sql?.split(";").filter((part) => part.trim()).length ?? 0;
      }
    };
    events.subscribe(observe);
    let result;
    try {
      result = commit(fresh.map(({ eventId, message }) => ({ eventId, message })));
    } finally {
      events.unsubscribe(observe);
    }
    expect(result.appendedMessages).toMatchObject(
      fresh.map(({ eventId, parentId }) => ({
        messageId: eventId,
        appended: true,
        effectiveParentId: parentId,
      })),
    );
    expect(select("transcript_updated_at, transcript_observed_at")).toEqual({
      transcript_updated_at: 20000 + count,
      transcript_observed_at: 20000,
    });
    const window = select("row_transcript_json") as { row_transcript_json: string };
    const lastAssistant = { text: `Message ${count - (count % 2 ? 2 : 1)}`, timestamp: 5000 };
    expect(JSON.parse(window.row_transcript_json).lastAssistantMessage).toEqual(
      count % 2 ? "unchanged" : lastAssistant,
    );
    expect(authority?.lastAssistantMessage).toEqual(count === 1 ? "unchanged" : lastAssistant);
    expect(
      database.db
        .prepare(
          "SELECT event_id, parent_id FROM transcript_event_identities WHERE session_id = ? AND event_type = 'message' ORDER BY seq",
        )
        .all(scope.sessionId),
    ).toEqual([
      { event_id: "seed", parent_id: null },
      ...fresh.map(({ eventId, parentId }) => ({ event_id: eventId, parent_id: parentId })),
    ]);
    // Budget is the real writer's SQL, including its required transaction envelope.
    expect(statements).toBeGreaterThan(0);
    expect(statements, `observed ${statements} statements for ${count} messages`).toBeLessThan(
      count === 1 ? 15 : count * 11 + 6,
    );
  },
);
