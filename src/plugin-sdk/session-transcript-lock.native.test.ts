import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  appendTranscriptMessageSync,
  withTranscriptWriteLock,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptWriteLockAccessorContext } from "../config/sessions/session-accessor.types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withSessionTranscriptWriteLock } from "./session-transcript-runtime.js";

async function seed(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", sessionId: "locked", sessionKey: "agent:main:locked", env };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  return { ...scope, storePath: openOpenClawAgentDatabase(scope).path };
}

it("drains accepted operations after callback failure and seals the native context", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    const entered = createDeferred();
    const release = createDeferred();
    const preparationFailure = new Error("Preparation failed");
    const callbackFailure = new Error("Callback failed");
    let retained: SessionTranscriptWriteLockAccessorContext | undefined;
    const accepted: Promise<unknown>[] = [];
    const writing = withTranscriptWriteLock(scope, (locked) => {
      retained = locked;
      accepted.push(
        locked.appendMessage({
          message: { role: "assistant", content: "rejected" },
          prepareMessageAfterIdempotencyCheckAsync: async () => {
            entered.resolve();
            await release.promise;
            throw preparationFailure;
          },
        }),
      );
      accepted.push(
        locked.appendMessageWithMessageSequence({
          eventId: "accepted",
          message: { role: "assistant", content: "settled" },
        }),
      );
      accepted.push(locked.readEvents());
      throw callbackFailure;
    });
    const outcome = writing.catch((error: unknown) => error);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, outcome, "Append was not retained"),
        signal,
      );
      assert(retained);
      await expect(retained.replaceEvents([])).rejects.toThrow("context is closed");
      release.resolve();
      const failure = await withinTest(outcome, signal);
      expect(failure).toBe(callbackFailure);
      await expect(accepted[0]).rejects.toBe(preparationFailure);
      await expect(accepted[1]).resolves.toMatchObject({ result: { messageId: "accepted" } });
      await expect(accepted[2]).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "accepted" })]),
      );
      await expect(
        withTranscriptWriteLock(scope, async (locked) => {
          await expect(
            locked.appendMessage({
              message: { role: "assistant", content: "handled refusal" },
              prepareMessageAfterIdempotencyCheckAsync: async () => {
                throw preparationFailure;
              },
            }),
          ).rejects.toBe(preparationFailure);
          return "recovered";
        }),
      ).resolves.toBe("recovered");
    } finally {
      release.resolve();
      await Promise.allSettled([writing, ...accepted]);
    }
  });
});

it("skips async preparation on replay and rejects a stale fresh preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = await seed(env);
    const database = openOpenClawAgentDatabase(scope);
    const original: {
      role: string;
      content: string;
      idempotencyKey: string;
      custom?: { toJSON(): never };
    } = {
      role: "assistant",
      content: "original",
      idempotencyKey: "original",
      custom: {
        toJSON() {
          throw new Error("Discarded input must not be serialized");
        },
      },
    };
    await withSessionTranscriptWriteLock(scope, (locked) =>
      locked.appendMessage({
        eventId: "original",
        message: original,
        prepareMessageAfterIdempotencyCheck: ({ custom: _custom, ...message }) => {
          expect(database.db.isTransaction).toBe(true);
          return message;
        },
      }),
    );
    const prepare = vi.fn(async () => {
      throw new Error("Replay must not prepare");
    });
    await expect(
      withSessionTranscriptWriteLock(scope, (locked) =>
        locked.appendMessage({
          message: original,
          prepareMessageAfterIdempotencyCheckAsync: prepare,
        }),
      ),
    ).resolves.toMatchObject({ appended: false, messageId: "original" });
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      withSessionTranscriptWriteLock(scope, (locked) =>
        locked.appendMessage({
          message: { ...original, idempotencyKey: "suppressed" },
          prepareMessageAfterIdempotencyCheckAsync: async () => undefined,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      withSessionTranscriptWriteLock(scope, (locked) =>
        locked.appendMessage({ message: undefined }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      withSessionTranscriptWriteLock(scope, (locked) =>
        locked.appendMessage({
          eventId: "stale",
          message: { role: "assistant", content: "stale" },
          prepareMessageAfterIdempotencyCheckAsync: async (message) => {
            expect(database.db.isTransaction).toBe(false);
            expect(
              appendTranscriptMessageSync(scope, {
                eventId: "concurrent",
                message: { role: "assistant", content: "concurrent" },
              }).ok,
            ).toBe(true);
            return message;
          },
        }),
      ),
    ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    expect(
      loadTranscriptEventsSync(scope)
        .filter(isRecord)
        .map((event) => event.id),
    ).toEqual([scope.sessionId, "original", "concurrent"]);
  });
});
