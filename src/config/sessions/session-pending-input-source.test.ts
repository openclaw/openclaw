import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  readSessionPendingInputInterruption,
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import * as pendingInputSource from "./session-pending-input-source.js";
import { readPendingInputSourceInDatabase } from "./session-pending-input-source.kernel.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";

describe("submitted input source evidence", () => {
  const fixture = useTempSessionsFixture("openclaw-submitted-source-");
  const sessionKey = "agent:main:submitted-source";
  const sessionId = "submitted-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => {
    const opened = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
    // Direct fixture writes may follow a worker read or post-commit projection work.
    opened.db.exec("PRAGMA busy_timeout = 15000");
    return opened;
  };
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

  describe("interrupted-before-commit proof", () => {
    const interrupted = (runId: string) =>
      readSessionPendingInputInterruption(scope(), `${runId}:user`);
    const interrupt = async (receipt: SessionPendingInputReceipt) => {
      receipt.finish("interrupted");
      await receipt.settled?.();
    };
    const setRow = (receipt: SessionPendingInputReceipt, column: string, value: string | null) =>
      database()
        .db.prepare(`UPDATE session_pending_inputs SET ${column} = ? WHERE input_id = ?`)
        .run(value, receipt.inputId);

    it("proves an interrupted, unowned, uncommitted input spent", async () => {
      const receipt = await stage("spent-source");
      await interrupt(receipt);
      expect(await interrupted("spent-source")).toBe("orphaned");
      const snapshot = readPendingInputSourceInDatabase(database(), {
        kind: "source",
        sessionKey,
        sessionId,
        idempotencyKey: "spent-source:user",
        pendingOnly: false,
        commitEvidence: true,
      });
      expect(snapshot.pending?.state).toBe("interrupted");
      expect(snapshot.pendingCommit).toEqual({ transcriptIndexCurrent: true, committed: false });
    });

    it("reports no commit evidence unless asked", async () => {
      await interrupt(await stage("plain-source"));
      expect(
        readPendingInputSourceInDatabase(database(), {
          kind: "source",
          sessionKey,
          sessionId,
          idempotencyKey: "plain-source:user",
          pendingOnly: false,
        }).pendingCommit,
      ).toBeUndefined();
    });

    it("rejects queued and cancelled inputs", async () => {
      const queued = await stage("queued-source");
      expect(await interrupted("queued-source")).toBe("not-orphaned");
      queued.finish("cancelled");
      await queued.settled?.();
      expect(database().db.prepare("SELECT state FROM session_pending_inputs").get()).toEqual({
        state: "cancelled",
      });
      expect(await interrupted("queued-source")).toBe("not-orphaned");
    });

    it("rejects an interrupted row that a live owner still holds", async () => {
      const receipt = await stage("owned-source");
      setRow(receipt, "state", "interrupted");
      expect(await interrupted("owned-source")).toBe("not-orphaned");
      setRow(receipt, "state", "queued");
      await interrupt(receipt);
      expect(await interrupted("owned-source")).toBe("orphaned");
    });

    it("rejects a consumed interrupted row", async () => {
      const receipt = await stage("consumed-source");
      await interrupt(receipt);
      setRow(receipt, "consumed_event_id", "event-1");
      expect(await interrupted("consumed-source")).toBe("not-orphaned");
    });

    it("rejects an interrupted row whose message reached the transcript", async () => {
      const receipt = await stage("committed-source");
      await interrupt(receipt);
      // Simulate a commit that raced the interruption: park the row's key so the
      // append is not attributed to the pending input, then restore it.
      setRow(receipt, "idempotency_key", "parked:user");
      await appendTranscriptMessage(scope(), { message: receipt.message });
      setRow(receipt, "idempotency_key", "committed-source:user");
      expect(
        database()
          .db.prepare("SELECT state FROM session_pending_inputs WHERE input_id = ?")
          .get(receipt.inputId),
      ).toEqual({ state: "interrupted" });
      expect(await interrupted("committed-source")).toBe("not-orphaned");
    });

    it("reports unavailable while the transcript identity projection is stale", async () => {
      const receipt = await stage("dirty-source");
      await interrupt(receipt);
      // A transcript must exist for its projection to be stale.
      await appendTranscriptMessage(scope(), { message: message("unrelated-source") });
      database()
        .db.prepare(
          "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
        )
        .run(sessionId);
      expect(
        readPendingInputSourceInDatabase(database(), {
          kind: "source",
          sessionKey,
          sessionId,
          idempotencyKey: "dirty-source:user",
          pendingOnly: false,
          commitEvidence: true,
        }).pendingCommit,
      ).toEqual({ transcriptIndexCurrent: false, committed: false });
      expect(await interrupted("dirty-source")).toBe("unavailable");
    });

    it("recovers a positive proof once a stale projection is reconciled", async () => {
      const receipt = await stage("restored-source");
      await interrupt(receipt);
      await appendTranscriptMessage(scope(), { message: message("restored-unrelated") });
      const db = database().db;
      const evidence = () =>
        readPendingInputSourceInDatabase(database(), {
          kind: "source",
          sessionKey,
          sessionId,
          idempotencyKey: "restored-source:user",
          pendingOnly: false,
          commitEvidence: true,
        }).pendingCommit;
      // Fixture writes precede the worker-backed proof read, which may hold the file.
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      ).run(sessionId);
      expect(evidence()).toEqual({ transcriptIndexCurrent: false, committed: false });
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 0 WHERE session_id = ?",
      ).run(sessionId);
      expect(evidence()).toEqual({ transcriptIndexCurrent: true, committed: false });
      expect(await interrupted("restored-source")).toBe("orphaned");
    });

    it("reports unavailable when the evidence read fails", async () => {
      const receipt = await stage("unreadable-source");
      await interrupt(receipt);
      setRow(
        receipt,
        "message_json",
        JSON.stringify(message("unreadable-source", "x".repeat(MAX_PAYLOAD_BYTES + 1))),
      );
      expect(await interrupted("unreadable-source")).toBe("unavailable");
    });

    it("never reports a settling owner as definitively owned", async () => {
      const receipt = await stage("settling-source");
      receipt.finish("interrupted");
      expect(await interrupted("settling-source")).not.toBe("not-orphaned");
      await receipt.settled?.();
      expect(await interrupted("settling-source")).toBe("orphaned");
    });

    it("never calls a queued snapshot definitive after its owner settles during the read", async () => {
      const receipt = await stage("raced-source");
      const read = pendingInputSource.readPendingInputSource;
      let captured: string | undefined;
      const spy = vi
        .spyOn(pendingInputSource, "readPendingInputSource")
        .mockImplementationOnce(async (...args) => {
          // Capture queued evidence, then let the owner commit `interrupted` and
          // unregister before the awaited read returns.
          const source = await read(...args);
          captured = source?.snapshot.pending?.state;
          await interrupt(receipt);
          return source;
        });
      try {
        expect(await interrupted("raced-source")).toBe("unavailable");
        expect(captured).toBe("queued");
        expect(spy).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
      }
      expect(await interrupted("raced-source")).toBe("orphaned");
    });

    it("treats an ownerless queued row as unavailable", async () => {
      const receipt = await stage("ownerless-source");
      await interrupt(receipt);
      setRow(receipt, "state", "queued");
      expect(await interrupted("ownerless-source")).toBe("unavailable");
    });

    it("rejects an input of a replaced session", async () => {
      const receipt = await stage("replaced-source");
      await interrupt(receipt);
      await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
      expect(await interrupted("replaced-source")).toBe("not-orphaned");
    });
  });
});
