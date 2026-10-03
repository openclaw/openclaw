// Covers the direct cron delivery wait window: the SQLite producer lease
// fences cross-process sends for 30 seconds, so the waiter must poll through
// the full window instead of abandoning one check before a lease-expiry
// completion is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
} from "../../infra/delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { waitForCompletedDirectCronDelivery } from "./delivery-dispatch-policy.js";

vi.mock("../../infra/delivery-queue-sqlite.js", () => ({
  getDeliveryQueueEntryStatus: vi.fn(),
  loadDeliveryQueueEntry: vi.fn(),
  OUTBOUND_DELIVERY_QUEUE_NAME: "probe-queue",
}));
vi.mock("../../infra/outbound/delivery-queue-media-staging.js", () => ({
  OUTBOUND_DELIVERY_QUEUE_NAME: "probe-queue",
}));
vi.mock("../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sleepWithAbort: vi.fn(),
}));

describe("waitForCompletedDirectCronDelivery lease window", () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(sleepWithAbort).mockImplementation(async () => {
      nowMs += 250;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("observes a send that completes exactly when its 30s lease expires", async () => {
    const startedAt = nowMs;
    vi.mocked(getDeliveryQueueEntryStatus).mockImplementation(() =>
      nowMs - startedAt >= 30_000 ? "completed" : "pending",
    );
    vi.mocked(loadDeliveryQueueEntry).mockReturnValue({
      id: "delivery-1",
      enqueuedAt: startedAt,
      retryCount: 0,
      recoveryState: "send_attempt_started",
      platformSendStartedAt: startedAt,
    });

    const completed = await waitForCompletedDirectCronDelivery({ id: "delivery-1" });

    // The lease stays valid through the 30s boundary; the waiter must reach it.
    expect(completed).toBe(true);
    expect(nowMs - startedAt).toBe(30_000);
  });

  it("gives up only after the 30s lease has fully elapsed", async () => {
    const startedAt = nowMs;
    vi.mocked(getDeliveryQueueEntryStatus).mockReturnValue("pending");
    vi.mocked(loadDeliveryQueueEntry).mockReturnValue({
      id: "delivery-2",
      enqueuedAt: startedAt,
      retryCount: 0,
      recoveryState: "send_attempt_started",
      platformSendStartedAt: startedAt,
    });

    const completed = await waitForCompletedDirectCronDelivery({ id: "delivery-2" });

    expect(completed).toBe(false);
    expect(nowMs - startedAt).toBe(30_000);
  });
});
