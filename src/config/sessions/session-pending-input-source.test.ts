import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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
const stage = async (runId: string, committed = false) => {
  await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  const receipt = await stageSessionPendingInput(scope(), {
    runId,
    message: message(runId),
    assertCurrent: () => {},
  });
  assert(receipt, "Expected staged source");
  receipts.push(receipt);
  if (committed) {
    await receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));
  }
  return receipt;
};
async function readOnly<T>(run: () => Promise<T>) {
  const db = database().db;
  db.exec("PRAGMA query_only = ON");
  try {
    return await run();
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
}
afterEach(async () => {
  for (const receipt of receipts) {
    receipt.finish("interrupted");
  }
  await Promise.allSettled(receipts.splice(0).map(async (receipt) => receipt.settled?.()));
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
    const receipt = await stage("invalid-source", source === "committed");
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
        const payload = Object.entries(prepareTranscriptPayload(db, `{"message":${messageJson}}`));
        db.prepare(
          `UPDATE transcript_events SET ${payload.map(([column]) => `${column} = ?`).join(", ")}
              WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)`,
        ).run(...payload.map(([, value]) => value), sessionId, sessionId, receipt.inputId);
      }
      await readOnly(async () => {
        const read = readSessionSubmittedInput(scope(), "invalid-source:user");
        if (messageJson.includes('"idempotencyKey":"another:user"')) {
          expect(await read).toBeUndefined();
        } else {
          await expect(read).rejects.toThrow();
        }
      });
    }
  },
);

it.each([
  { projection: "dirty", set: "needs_rebuild = 1" },
  { projection: "missing", set: null },
  { projection: "lagging", set: "indexed_seq = -1" },
])("does not read or repair a $projection transcript identity projection", async ({ set }) => {
  await stage("stale-source", true);
  const db = database().db;
  db.prepare(
    set
      ? `UPDATE session_transcript_index_state SET ${set} WHERE session_id = ?`
      : "DELETE FROM session_transcript_index_state WHERE session_id = ?",
  ).run(sessionId);
  const readIndex = () =>
    db.prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?").get(sessionId);
  const before = readIndex();
  await readOnly(async () => {
    await expect(readSessionSubmittedInput(scope(), "stale-source:user")).rejects.toBeInstanceOf(
      SessionTranscriptProjectionUnavailableError,
    );
  });
  expect(readIndex()).toEqual(before);
});
