import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { createGatewayMetadataCloseFixture } from "../gateway/server-close.metadata.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withSessionTranscriptWriteLock,
  type SessionTranscriptWriteLockContext,
} from "./session-transcript-runtime.js";

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
    const original = { role: "assistant", content: "original", idempotencyKey: "original" };
    await withSessionTranscriptWriteLock(scope, (locked) =>
      locked.appendMessage({
        eventId: "original",
        message: original,
        prepareMessageAfterIdempotencyCheck: (message) => {
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
          message: { role: "assistant", content: "suppressed" },
          prepareMessageAfterIdempotencyCheckAsync: async () => undefined,
        }),
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

it("settles two unawaited native appends FIFO across the real Gateway close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-native-locked-close");
  const entered = createDeferred();
  const release = createDeferred();
  const prelude = createDeferred();
  const accepted: Promise<unknown>[] = [];
  let writing: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let retained: SessionTranscriptWriteLockContext | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const scope = await seed(fixture.state.env);
    const database = openOpenClawAgentDatabase(scope);
    const order: string[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "native-locked-appends",
      delayMs: 0,
      async run() {
        // An opaque released SDK assertion deliberately retains the native adapter.
        writing = withSessionTranscriptWriteAssertion(
          scope,
          () => {
            expect(database.db.isOpen).toBe(true);
          },
          () =>
            withSessionTranscriptWriteLock(scope, (locked) => {
              retained = locked;
              accepted.push(
                locked.appendMessage({
                  eventId: "first",
                  message: { role: "assistant", content: "first" },
                  prepareMessageAfterIdempotencyCheckAsync: async (message) => {
                    expect(database.db.isTransaction).toBe(false);
                    entered.resolve();
                    await release.promise;
                    return message;
                  },
                  beforeFreshMessageCommit: () => {
                    expect(database.db.isTransaction).toBe(true);
                    order.push("first");
                  },
                }),
              );
              accepted.push(
                locked.appendMessage({
                  eventId: "second",
                  message: { role: "assistant", content: "second" },
                  beforeFreshMessageCommit: () => order.push("second"),
                }),
              );
              return "callback returned";
            }),
        );
        expect(await writing).toBe("callback returned");
        expect(database.db.isOpen).toBe(true);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    assert(writing);
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, writing, "Append was not retained"),
      signal,
    );
    kernel.scheduler.signal.addEventListener("abort", () => prelude.resolve(), { once: true });
    closing = server.close({ reason: "native locked append settlement" });
    await withinTest(
      awaitGateBeforeSettlement(prelude.promise, closing, "Gateway skipped close prelude"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    assert(retained);
    await expect(retained.publishUpdate()).rejects.toThrow("context is closed");
    await expect(retained.readEvents()).rejects.toThrow("context is closed");
    expect(order).toEqual([]);
    expect(database.db.isOpen).toBe(true);
    release.resolve();
    await withinTest(Promise.all([writing, closing, ...accepted]), signal);
    expect(order).toEqual(["first", "second"]);
    expect(database.db.isOpen).toBe(false);
    const reopened = new DatabaseSync(database.path, { readOnly: true });
    try {
      const rows = reopened
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId);
      expect(
        rows.map((row) => {
          assert(typeof row.event_json === "string");
          return JSON.parse(row.event_json).id;
        }),
      ).toEqual([scope.sessionId, "first", "second"]);
    } finally {
      reopened.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([writing, closing, ...accepted]);
    await fixture.cleanup();
  }
});
