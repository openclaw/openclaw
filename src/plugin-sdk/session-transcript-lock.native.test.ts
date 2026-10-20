import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  appendTranscriptMessageSync,
  withTranscriptWriteLock,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteLockAccessorContext,
} from "../config/sessions/session-accessor.types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withSessionTranscriptWriteLock } from "./session-transcript-runtime.js";

const message = (content: string) => ({ role: "assistant", content });
const fail = async (error: Error): Promise<never> => {
  throw error;
};
async function seed(env: NodeJS.ProcessEnv) {
  await captureRuntimeConfigAsyncReader()();
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
          message: message("rejected"),
          prepareMessageAfterIdempotencyCheckAsync: async () => {
            entered.resolve();
            await release.promise;
            return fail(preparationFailure);
          },
        }),
        locked.appendMessageWithMessageSequence({
          eventId: "accepted",
          message: message("settled"),
        }),
        locked.readEvents(),
      );
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
      expect(await withinTest(outcome, signal)).toBe(callbackFailure);
      await expect(accepted[0]).rejects.toBe(preparationFailure);
      await expect(accepted[1]).resolves.toMatchObject({ result: { messageId: "accepted" } });
      expect(await accepted[2]).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "accepted" })]),
      );
      await expect(
        withTranscriptWriteLock(scope, async (locked) => {
          await expect(
            locked.appendMessage({
              message: message("handled refusal"),
              prepareMessageAfterIdempotencyCheckAsync: () => fail(preparationFailure),
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
    const original: ReturnType<typeof message> & {
      idempotencyKey: string;
      custom?: { toJSON(): never };
    } = {
      ...message("original"),
      idempotencyKey: "original",
      custom: {
        toJSON: () => {
          throw new Error("Discarded input must not be serialized");
        },
      },
    };
    const append = <TMessage>(options: LockedTranscriptMessageAppendOptions<TMessage>) =>
      withSessionTranscriptWriteLock(scope, (locked) => locked.appendMessage(options));
    await append({
      eventId: "original",
      message: original,
      prepareMessageAfterIdempotencyCheck: ({ custom: _custom, ...prepared }) => {
        expect(database.db.isTransaction).toBe(true);
        return prepared;
      },
    });
    const prepare = vi.fn(() => fail(new Error("Replay must not prepare")));
    await expect(
      append({ message: original, prepareMessageAfterIdempotencyCheckAsync: prepare }),
    ).resolves.toMatchObject({ appended: false, messageId: "original" });
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      append({
        message: { ...original, idempotencyKey: "suppressed" },
        prepareMessageAfterIdempotencyCheckAsync: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    await expect(append({ message: undefined })).resolves.toBeUndefined();
    await expect(
      append({
        eventId: "stale",
        message: message("stale"),
        prepareMessageAfterIdempotencyCheckAsync: async (prepared) => {
          expect(database.db.isTransaction).toBe(false);
          expect(
            appendTranscriptMessageSync(scope, {
              eventId: "concurrent",
              message: message("concurrent"),
            }).ok,
          ).toBe(true);
          return prepared;
        },
      }),
    ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    expect(
      loadTranscriptEventsSync(scope)
        .filter(isRecord)
        .map((event) => event.id),
    ).toEqual([scope.sessionId, "original", "concurrent"]);
  });
});
