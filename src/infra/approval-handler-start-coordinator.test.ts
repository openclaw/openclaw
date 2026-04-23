import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalHandlerStartCoordinator,
  resolveApprovalHandlerMaxConcurrentStarts,
  resolveApprovalHandlerStartJitterMs,
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
