import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";

describe("submitted input source evidence", () => {
  const fixture = useTempSessionsFixture("openclaw-submitted-source-");
  const sessionKey = "agent:main:submitted-source";
  const sessionId = "submitted-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string, content = "Synthetic source"): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const stage = async (runId: string) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected staged source");
    }
    receipts.push(receipt);
    return receipt;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    for (const receipt of receipts) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled(receipts.splice(0).map(async (receipt) => receipt.settled?.()));
    closeOpenClawAgentDatabasesForTest();
  });
  it("does not create missing storage for a submitted-input lookup", async () => {
    const storePath = path.join(fixture.sessionsDir(), "missing-agent.sqlite");
    expect(
      await readSessionSubmittedInput({ ...scope(), storePath }, "missing:user"),
    ).toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each(["pending", "committed"] as const)(
    "rejects malformed or oversized %s source bytes without changing storage",
    async (source) => {
      const receipt = await stage("invalid-source");
      if (source === "committed") {
        await promote(receipt);
      }
      const db = database().db;
      const invalidMessages = [
        "{",
        JSON.stringify({ ...receipt.message, role: "assistant" }),
        JSON.stringify({ ...receipt.message, idempotencyKey: "another:user" }),
        JSON.stringify(message("invalid-source", "💥".repeat(MAX_PAYLOAD_BYTES / 4))),
      ];
      for (const messageJson of invalidMessages) {
        if (source === "pending") {
          db.prepare("UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?").run(
            messageJson,
            receipt.inputId,
          );
        } else {
          const payload = prepareTranscriptPayload(db, `{"message":${messageJson}}`);
          db.prepare(
            "UPDATE transcript_events SET event_json = ?, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
          ).run(
            payload.event_json,
            payload.event_zstd,
            payload.event_utf8_bytes,
            payload.navigation_json,
            sessionId,
            sessionId,
            receipt.inputId,
          );
        }
        db.exec("PRAGMA query_only = ON");
        try {
          const read = readSessionSubmittedInput(scope(), "invalid-source:user");
          if (messageJson.includes('"idempotencyKey":"another:user"')) {
            expect(await read).toBeUndefined();
          } else {
            await expect(read).rejects.toThrow();
          }
        } finally {
          db.exec("PRAGMA query_only = OFF");
        }
      }
    },
  );

  it.each(["dirty", "missing", "lagging"] as const)(
    "does not read or repair a %s transcript identity projection",
    async (projection) => {
      const receipt = await stage("stale-source");
      await promote(receipt);
      const db = database().db;
      if (projection === "missing") {
        db.prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?").run(
          sessionId,
        );
      } else {
        const statement =
          projection === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?";
        db.prepare(statement).run(sessionId);
      }
      const before = db
        .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
        .get(sessionId);
      db.exec("PRAGMA query_only = ON");
      try {
        await expect(
          readSessionSubmittedInput(scope(), "stale-source:user"),
        ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
      } finally {
        db.exec("PRAGMA query_only = OFF");
      }
      expect(
        db
          .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual(before);
    },
  );
});
