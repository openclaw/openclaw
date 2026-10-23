import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  registerReplyOperationSuccessorBarrier,
  ReplyRunSuccessorAdmissionBlockedError,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

async function withFakeReplyTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
}

function barrier(
  operation: ReturnType<typeof createTestReplyOperation>,
  sessionKeys = [operation.key],
) {
  const release = createDeferred();
  registerReplyOperationSuccessorBarrier({
    operation,
    sessionId: operation.sessionId,
    sessionKeys,
    start: () => release.promise,
  });
  return release;
}

function settledSource(operation: ReturnType<typeof createTestReplyOperation>, sessionId: string) {
  return {
    settled: true,
    sources: [
      {
        sessionId,
        sessionIds: operation.captureOwnedSessionIds(),
        operation,
        databaseIdentity: undefined,
      },
    ],
  };
}

function expectBlocked(sessionKey: string) {
  expect(() => createTestReplyOperation({ sessionKey })).toThrow(
    ReplyRunSuccessorAdmissionBlockedError,
  );
}

describe("reply run successor barriers", () => {
  afterEach(() => {
    testing.resetSessionControllerForTest();
    resetCommandQueueStateForTest();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("fences every durable alias until successor handoff settles", async () => {
    await withFakeReplyTimers(async () => {
      const requestKey = "agent:main:telegram:alias:request";
      const canonicalKey = "agent:main:telegram:alias:canonical";
      const adoptedKey = "agent:main:telegram:alias:adopted";
      const operation = createTestReplyOperation({
        sessionKey: requestKey,
        sessionId: "alias-session",
      });
      const firstBarrier = barrier(operation, [requestKey, canonicalKey]);
      const secondBarrier = barrier(operation, [adoptedKey]);

      operation.updateSessionId("rotated-alias-session");
      operation.complete();
      for (const sessionKey of [requestKey, canonicalKey, adoptedKey]) {
        expectBlocked(sessionKey);
      }
      const timedWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedWait).resolves.toEqual({ settled: false });

      const requestWait = waitForReplyRunSuccessorAdmission(requestKey, 100);
      const canonicalWait = waitForReplyRunSuccessorAdmission(canonicalKey, 100);
      firstBarrier.resolve();
      for (const wait of [requestWait, canonicalWait]) {
        await expect(wait).resolves.toEqual(settledSource(operation, "rotated-alias-session"));
      }
      expectBlocked(adoptedKey);
      secondBarrier.resolve();
      await expect(waitForReplyRunSuccessorAdmission(adoptedKey, 100)).resolves.toEqual(
        settledSource(operation, "rotated-alias-session"),
      );
      const successor = createTestReplyOperation({ sessionKey: canonicalKey });
      successor.complete();
    });
  });

  it.each(["pending", "rejected"] as const)(
    "starts a late deferred release and keeps successors fenced while it is %s",
    async (releaseState) => {
      const operation = createTestReplyOperation();
      operation.complete();
      const entered = createDeferred();
      const release = createDeferred();
      const start = vi.fn(() => {
        entered.resolve();
        return release.promise;
      });
      const controller = new AbortController();
      let wait: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
      try {
        registerReplyOperationSuccessorBarrier({
          operation,
          sessionId: operation.sessionId,
          sessionKeys: [operation.key],
          deferUntilClear: true,
          start,
        });
        expect(start).toHaveBeenCalledOnce();
        await entered.promise;
        if (releaseState === "rejected") {
          release.reject(new Error("Synthetic late release failure"));
          await Promise.allSettled([release.promise]);
        }
        expectBlocked(operation.key);
        wait = waitForReplyRunSuccessorAdmission(operation.key, null, {
          signal: controller.signal,
        });
        controller.abort();
        await expect(wait).resolves.toEqual({ settled: false });
        expectBlocked(operation.key);
        if (releaseState === "pending") {
          release.resolve();
          await expect(
            waitForReplyRunSuccessorAdmission(operation.key, null),
          ).resolves.toMatchObject({
            settled: true,
          });
          const successor = createTestReplyOperation({ sessionKey: operation.key });
          successor.complete();
        }
        expect(start).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
        release.resolve();
        await Promise.allSettled([release.promise]);
        await wait;
      }
    },
  );

  it("cancels a bounded wait without releasing the successor fence", async () => {
    const operation = createTestReplyOperation();
    const release = barrier(operation);
    operation.complete();
    const controller = new AbortController();
    try {
      const wait = waitForReplyRunSuccessorAdmission(operation.key, 100, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(wait).resolves.toEqual({ settled: false });
      expectBlocked(operation.key);
    } finally {
      release.resolve();
      await waitForReplyRunSuccessorAdmission(operation.key, null);
    }
  });

  it("waits for the captured physical owner when logical keys are ambiguous", async () => {
    const sessionKey = "global";
    const firstTarget = captureSessionTarget({
      storeScope: "/synthetic/successor-barrier/first.sqlite",
      sessionKey,
    });
    const secondTarget = captureSessionTarget({
      storeScope: "/synthetic/successor-barrier/second.sqlite",
      sessionKey,
    });
    const first = createTestReplyOperation({
      sessionKey,
      sessionId: "first-session",
      target: firstTarget,
    });
    const second = createTestReplyOperation({
      sessionKey,
      sessionId: "second-session",
      target: secondTarget,
    });
    const firstRelease = barrier(first);
    const secondRelease = barrier(second);
    first.complete();
    second.complete();

    let settled = false;
    const wait = waitForReplyRunSuccessorAdmission(sessionKey, null, {
      target: firstTarget,
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    firstRelease.resolve();
    await expect(wait).resolves.toMatchObject({ settled: true });
    expect(() =>
      createTestReplyOperation({
        sessionKey,
        sessionId: "still-blocked",
        target: secondTarget,
      }),
    ).toThrow(ReplyRunSuccessorAdmissionBlockedError);

    secondRelease.resolve();
  });
});
