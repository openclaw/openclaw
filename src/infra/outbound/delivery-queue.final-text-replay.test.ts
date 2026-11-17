import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const resolveAdapter = vi.hoisted(() => vi.fn());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveAdapter,
}));
vi.mock("../../utils/sleep.js", () => ({ sleep: vi.fn(async () => undefined) }));

describe("final text replay after a crash mid-send", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  beforeEach(() => resolveAdapter.mockReset());

  it.each([
    ["no reconciliation", undefined, 1, 1],
    ["unresolved reconciliation", { status: "unresolved", error: "lookup failed" }, 1, 1],
    ["reconciled as sent", { status: "sent", messageId: "platform-1" }, 1, 0],
    ["a second crash, during the resend", undefined, 2, 0],
  ] as const)("%s", async (_label, reconciliation, startedAttempts, expectedSends) => {
    if (reconciliation) {
      resolveAdapter.mockReturnValue({
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend: vi.fn().mockResolvedValue(reconciliation),
        },
      });
    }
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "Saved final answer" }],
        retryAmbiguousFinalText: true,
        requiresProducerClaim: true,
      },
      tmpDir(),
    );
    const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
    // Two reserved attempts stand for the original send plus a resend that also crashed.
    for (let attempt = 0; attempt < startedAttempts; attempt++) {
      await reserveDeliveryAttempt(id, 5, tmpDir(), claimId);
    }
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, claimId);
    // The Gateway dies here: no outcome is recorded and the claim lease expires.
    setQueuedEntryState(tmpDir(), id, { retryCount: 0, availableAt: Date.now() - 1 });
    expect((await loadPendingDeliveries(tmpDir()))[0]).toMatchObject({
      attemptCount: startedAttempts,
      recoveryState: "send_attempt_started",
    });
    const deliver = vi.fn<DeliverFn>(async (params) => {
      await markDeliveryPlatformSendAttemptStarted(
        id,
        tmpDir(),
        undefined,
        params.deliveryProducerClaimId,
      );
      await params.onPlatformSendStart?.({});
      return [{ channel: "demo-channel-a", messageId: "recovered-final" }];
    });
    const log = createRecoveryLog();
    await recoverPendingDeliveries({ deliver, log, cfg: {}, stateDir: tmpDir() });
    expect(deliver).toHaveBeenCalledTimes(expectedSends);
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    if (startedAttempts === 2) {
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("refusing blind replay"));
    }
  });
});
