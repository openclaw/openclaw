import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalHandlerStartCoordinator,
  resolveApprovalHandlerMaxConcurrentStarts,
  resolveApprovalHandlerStartJitterMs,
  resolveApprovalHandlerStartSlotMaxHoldMs,
} from "./approval-handler-start-coordinator.js";

describe("resolveApprovalHandlerStartJitterMs", () => {
  it("falls back to the default when the env var is unset", () => {
    expect(resolveApprovalHandlerStartJitterMs({})).toBe(2_000);
  });

  it("honors a valid non-negative integer env override", () => {
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "250",
      } as NodeJS.ProcessEnv),
    ).toBe(250);
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(0);
  });

  it("ignores non-numeric and negative env values", () => {
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "nope",
      } as NodeJS.ProcessEnv),
    ).toBe(2_000);
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "-100",
      } as NodeJS.ProcessEnv),
    ).toBe(2_000);
  });

  it("rejects partial-number env values like '100ms' and '3.5'", () => {
    // Number.parseInt is lenient and would accept these; we reject anything
    // that isn't a pure non-negative integer so misconfigurations surface as
    // "default" instead of a silently-truncated value.
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "100ms",
      } as NodeJS.ProcessEnv),
    ).toBe(2_000);
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "3.5",
      } as NodeJS.ProcessEnv),
    ).toBe(2_000);
    expect(
      resolveApprovalHandlerStartJitterMs({
        OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS: "  250 ",
      } as NodeJS.ProcessEnv),
    ).toBe(2_000);
  });
});

describe("resolveApprovalHandlerMaxConcurrentStarts", () => {
  it("falls back to the default when the env var is unset", () => {
    expect(resolveApprovalHandlerMaxConcurrentStarts({})).toBe(3);
  });

  it("honors a valid positive integer env override", () => {
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "7",
      } as NodeJS.ProcessEnv),
    ).toBe(7);
  });

  it("ignores zero, negative, and non-numeric env values", () => {
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "-3",
      } as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "nope",
      } as NodeJS.ProcessEnv),
    ).toBe(3);
  });

  it("rejects partial-number env values like '7x' and '2.5' for max-concurrent-starts", () => {
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "7x",
      } as NodeJS.ProcessEnv),
    ).toBe(3);
    expect(
      resolveApprovalHandlerMaxConcurrentStarts({
        OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS: "2.5",
      } as NodeJS.ProcessEnv),
    ).toBe(3);
  });
});

describe("resolveApprovalHandlerStartSlotMaxHoldMs", () => {
  it("falls back to the default when the env var is unset", () => {
    expect(resolveApprovalHandlerStartSlotMaxHoldMs({})).toBe(30_000);
  });

  it("honors a valid positive integer env override", () => {
    expect(
      resolveApprovalHandlerStartSlotMaxHoldMs({
        OPENCLAW_APPROVAL_HANDLER_START_SLOT_MAX_HOLD_MS: "5000",
      } as NodeJS.ProcessEnv),
    ).toBe(5_000);
  });

  it("ignores zero, negative, non-numeric, and partial-number env values", () => {
    expect(
      resolveApprovalHandlerStartSlotMaxHoldMs({
        OPENCLAW_APPROVAL_HANDLER_START_SLOT_MAX_HOLD_MS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      resolveApprovalHandlerStartSlotMaxHoldMs({
        OPENCLAW_APPROVAL_HANDLER_START_SLOT_MAX_HOLD_MS: "-1000",
      } as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      resolveApprovalHandlerStartSlotMaxHoldMs({
        OPENCLAW_APPROVAL_HANDLER_START_SLOT_MAX_HOLD_MS: "5000ms",
      } as NodeJS.ProcessEnv),
    ).toBe(30_000);
  });
});

describe("createApprovalHandlerStartCoordinator", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const notCanceled = () => false;

  it("resolves waitJitter immediately when jitter is disabled", async () => {
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 4,
    });
    await expect(coordinator.waitJitter(notCanceled)).resolves.toBeUndefined();
  });

  it("waits up to jitterMs * random() before resolving", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 1_000,
      maxConcurrentStarts: 4,
      random: () => 0.25,
    });
    let resolved = false;
    const waitPromise = coordinator.waitJitter(notCanceled).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("clamps jitter sampling to [0, jitterMs) even when random() returns 1", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 1_000,
      maxConcurrentStarts: 4,
      random: () => 1,
    });
    let resolved = false;
    const waitPromise = coordinator.waitJitter(notCanceled).then(() => {
      resolved = true;
    });

    // With clamp: max sampled delay is jitterMs - 1 = 999ms.
    await vi.advanceTimersByTimeAsync(998);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it("short-circuits waitJitter when canceled up front", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 5_000,
      maxConcurrentStarts: 4,
      random: () => 0.9,
    });
    const canceled = () => true;
    // Should resolve on the same tick without advancing timers.
    await coordinator.waitJitter(canceled);
  });

  it("serializes acquireStartSlot beyond the concurrency cap and serves waiters FIFO", async () => {
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 2,
    });

    const first = await coordinator.acquireStartSlot(notCanceled);
    const second = await coordinator.acquireStartSlot(notCanceled);

    let thirdResolved = false;
    let fourthResolved = false;
    const thirdPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      thirdResolved = true;
      return release;
    });
    const fourthPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      fourthResolved = true;
      return release;
    });

    // Give the microtask queue a chance to drain without releasing slots.
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(fourthResolved).toBe(false);

    first();
    const thirdRelease = await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(fourthResolved).toBe(false);

    second();
    const fourthRelease = await fourthPromise;
    expect(fourthResolved).toBe(true);

    thirdRelease();
    fourthRelease();
  });

  it("treats repeated release() calls as idempotent", async () => {
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
    });

    const first = await coordinator.acquireStartSlot(notCanceled);
    first();
    first();

    // The semaphore is not wedged; a fresh acquire resolves immediately.
    const second = await coordinator.acquireStartSlot(notCanceled);
    second();
  });

  it("force-releases a start slot after the configured hold timeout so one hung start cannot starve others", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
      startSlotMaxHoldMs: 500,
    });

    // Acquire a slot and DO NOT release it, simulating a `handler.start()`
    // that hangs on pending-approval replay or some other unbounded work.
    await coordinator.acquireStartSlot(notCanceled);

    let secondResolved = false;
    const secondPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      secondResolved = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(499);
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const secondRelease = await secondPromise;
    expect(secondResolved).toBe(true);

    secondRelease();
  });

  it("cancels the hold-timeout watchdog when the caller releases normally", async () => {
    vi.useFakeTimers();
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
      startSlotMaxHoldMs: 1_000,
    });

    // Acquire slot 1 and release it immediately. Its hold-timeout watchdog
    // is still scheduled on the event loop; the contract says the explicit
    // release must have canceled it.
    const first = await coordinator.acquireStartSlot(notCanceled);
    first();

    // Advance the clock past what WOULD have been slot 1's hold deadline.
    // If the watchdog fired after the explicit release we'd see a double
    // release: releaseSlot() runs twice, driving `active` negative. That
    // corruption surfaces in the FIFO check below — a broken watchdog would
    // let slot 3 acquire immediately even though slot 2 is still holding.
    await vi.advanceTimersByTimeAsync(1_500);

    const second = await coordinator.acquireStartSlot(notCanceled);
    let thirdResolved = false;
    const thirdPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      thirdResolved = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false); // correctly queued — slot 2 is still holding

    second();
    const thirdRelease = await thirdPromise;
    expect(thirdResolved).toBe(true);
    thirdRelease();
  });

  it("skips canceled waiters when dequeuing so stale generations do not consume FIFO turns", async () => {
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
    });

    const holder = await coordinator.acquireStartSlot(notCanceled);

    // Two waiters queued while the slot is held. Waiter B gets canceled
    // after enqueueing — its isCanceled returns true only on re-evaluation
    // at dequeue time, which is the scenario the hand-off logic must cover.
    let bCanceled = false;
    let bResolvedAt: number | undefined;
    let cResolvedAt: number | undefined;
    const bPromise = coordinator
      .acquireStartSlot(() => bCanceled)
      .then((release) => {
        bResolvedAt = Date.now();
        return release;
      });
    const cPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      cResolvedAt = Date.now();
      return release;
    });

    // Both pending; no resolution yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(bResolvedAt).toBeUndefined();
    expect(cResolvedAt).toBeUndefined();

    // Cancel B mid-queue, then release the holder. releaseSlot must skip B
    // and hand the slot directly to C rather than burning a FIFO turn on B.
    bCanceled = true;
    holder();

    const bRelease = await bPromise;
    const cRelease = await cPromise;
    expect(bResolvedAt).toBeDefined();
    expect(cResolvedAt).toBeDefined();

    // C must have acquired the live slot (not queued behind B's
    // no-op-and-release churn). Queue a fourth acquirer: it should be queued
    // because C is still holding the one slot.
    let dResolvedAt: number | undefined;
    const dPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      dResolvedAt = Date.now();
      return release;
    });
    await Promise.resolve();
    expect(dResolvedAt).toBeUndefined();

    cRelease();
    const dRelease = await dPromise;
    expect(dResolvedAt).toBeDefined();
    dRelease();
    bRelease(); // no-op; verifies B's canceled release doesn't corrupt state.
  });

  it("hands back a no-op release and does not consume a slot when canceled up front", async () => {
    const coordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
    });

    const canceledRelease = await coordinator.acquireStartSlot(() => true);
    canceledRelease();

    // Two concurrent acquisitions should both be available because the
    // canceled acquire never incremented the active count.
    const first = await coordinator.acquireStartSlot(notCanceled);
    // The second call should queue because cap is 1.
    let secondResolved = false;
    const secondPromise = coordinator.acquireStartSlot(notCanceled).then((release) => {
      secondResolved = true;
      return release;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first();
    const secondRelease = await secondPromise;
    expect(secondResolved).toBe(true);
    secondRelease();
  });
});
