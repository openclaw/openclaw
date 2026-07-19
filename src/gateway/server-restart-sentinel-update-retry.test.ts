import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleUpdateTransactionNoticeDelivery,
  scheduleConfirmedUpdateProbationRelease,
  scheduleUpdateTransactionRetry,
} from "./server-restart-sentinel-update-retry.js";

const markDeliveryAck = vi.hoisted(() => vi.fn());
const sealReplayAdmissions = vi.hoisted(() =>
  vi.fn<(handoffId: string) => Promise<boolean>>(async () => true),
);
const resolveProbation = vi.hoisted(() =>
  vi.fn<(handoffId: string, resolution: string) => Promise<void>>(async () => {}),
);

vi.mock("../infra/update-confirmation-runtime.js", () => ({
  resolveUpdateConfirmationProbation: (handoffId: string, resolution: string) =>
    resolveProbation(handoffId, resolution),
  sealUpdateConfirmationReplayAdmissions: (handoffId: string) => sealReplayAdmissions(handoffId),
}));

vi.mock("../infra/update-transaction-marker.js", () => ({
  markUpdateTransactionDeliveryAck: (params: unknown) => markDeliveryAck(params),
}));

afterEach(() => {
  vi.useRealTimers();
  markDeliveryAck.mockReset();
  sealReplayAdmissions.mockClear();
  resolveProbation.mockClear();
});

describe("scheduleUpdateTransactionRetry", () => {
  it("retries a confirmed probation release resumed after restart", async () => {
    vi.useFakeTimers();
    resolveProbation.mockRejectedValueOnce(new Error("state locked"));

    scheduleConfirmedUpdateProbationRelease("handoff-resumed");
    await vi.advanceTimersByTimeAsync(2);

    expect(resolveProbation).toHaveBeenCalledTimes(2);
    expect(resolveProbation).toHaveBeenLastCalledWith("handoff-resumed", "confirmed");
  });

  it("retries an acknowledged notice when confirmation persistence fails", async () => {
    vi.useFakeTimers();
    markDeliveryAck.mockRejectedValueOnce(new Error("state locked")).mockResolvedValueOnce({
      payload: {
        stats: { confirmationTier: "delivery", confirmationStatus: "delivery-acked" },
      },
    });
    const scheduleRetry = vi.fn();

    await handleUpdateTransactionNoticeDelivery({
      payload: {
        kind: "update",
        status: "skipped",
        ts: 1,
        stats: {
          handoffId: "handoff-1",
          updatePhase: "healthy",
          confirmationTier: "delivery",
          confirmationStatus: "pending",
        },
      },
      delivery: "acknowledged",
      scheduleRetry,
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(markDeliveryAck).toHaveBeenCalledTimes(2);
    expect(sealReplayAdmissions).toHaveBeenCalledTimes(2);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it("retries probation release after the acknowledgement is durable", async () => {
    vi.useFakeTimers();
    markDeliveryAck.mockResolvedValue({
      payload: {
        stats: { confirmationTier: "delivery", confirmationStatus: "delivery-acked" },
      },
    });
    resolveProbation.mockRejectedValueOnce(new Error("queue locked"));

    await handleUpdateTransactionNoticeDelivery({
      payload: {
        kind: "update",
        status: "skipped",
        ts: 1,
        stats: {
          handoffId: "handoff-1",
          updatePhase: "healthy",
          confirmationTier: "delivery",
          confirmationStatus: "pending",
        },
      },
      delivery: "acknowledged",
      scheduleRetry: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(markDeliveryAck).toHaveBeenCalledTimes(2);
    expect(resolveProbation).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying beyond the old fixed attempt ceiling", async () => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => {});

    scheduleUpdateTransactionRetry({
      attempt: 1_200,
      retry,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(retry).toHaveBeenCalledWith(1_201);
  });

  it("rearms the retry chain after a transient retry rejection", async () => {
    vi.useFakeTimers();
    const retry = vi
      .fn<(attempt: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue locked"))
      .mockResolvedValueOnce();
    const onError = vi.fn();

    scheduleUpdateTransactionRetry({ attempt: 4, retry, onError });
    await vi.advanceTimersByTimeAsync(2);

    expect(retry).toHaveBeenNthCalledWith(1, 5);
    expect(retry).toHaveBeenNthCalledWith(2, 6);
    expect(onError).toHaveBeenCalledOnce();
  });
});
