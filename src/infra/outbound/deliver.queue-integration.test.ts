// Integration test: real SQLite delivery queue + mock adapter.
// Verifies the patch end-to-end at the queue layer: when a required-mode
// batch send fails mid-batch after an earlier payload already succeeded,
// the queue entry advances to recovery_state=unknown_after_send (not left
// in send_attempt_started), so reconnect-drain routes it through
// reconcileUnknownQueuedDelivery instead of blind replay.
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("deliverOutboundPayloads queue integration: mid-batch failure with send evidence", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  it("advances queued entry to unknown_after_send when a later payload fails after an earlier one succeeded", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    // First payload succeeds (send evidence), second payload throws.
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1" })
      .mockRejectedValueOnce(new Error("second payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("second payload send failed");

    // The entry must exist in the real SQLite queue and be in unknown_after_send.
    const entries = await import("./delivery-queue.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.recoveryState).toBe("unknown_after_send");
    expect(entry.retryCount).toBe(0);
    expect(entry.lastError).toBeUndefined();
    // Sanity: the send actually happened for the first payload.
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("leaves entry for retry (failDelivery, recovery_state stays null) when no send evidence", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    // First (and only) payload fails immediately — no send evidence.
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    const entries = await import("./delivery-queue.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // No send evidence -> failDelivery path: retryCount bumped, recovery_state not advanced.
    expect(entry.retryCount).toBe(1);
    expect(entry.recoveryState).toBe("send_attempt_started");
    expect(entry.lastError).toContain("first payload send failed");
  });
});
