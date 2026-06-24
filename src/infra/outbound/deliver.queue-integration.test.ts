// Integration test: real SQLite delivery queue + mock adapter.
// Verifies the patch end-to-end at the queue layer: when a required-mode
// batch send fails mid-batch after an earlier payload already succeeded,
// the queue entry advances to recovery_state=unknown_after_send (not left
// in send_attempt_started), so reconnect-drain routes it through
// reconcileUnknownQueuedDelivery instead of blind replay.
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { drainPendingDeliveries, type DeliverFn, loadPendingDeliveries } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

// Minimal reconnect drain helper (no adapter → reconcileUnknownQueuedDelivery returns null).
async function drainMatrixReconnect(opts: { deliver: DeliverFn; stateDir: string }): Promise<void> {
  await drainPendingDeliveries({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix" }),
  });
}

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

  it("drain does not replay an unknown_after_send entry when no adapter reconciliation is available", async () => {
    // Regression guard for the recovery/drain semantics: an entry in
    // unknown_after_send (written by the patch above) must NOT be blindly
    // replayed when the channel adapter cannot reconcile the unknown send.
    // Without the patch the entry would stay in send_attempt_started, which
    // has the same drain behaviour — but this test pins the contract so that
    // any future regression that accidentally advances the state in a way that
    // re-enables blind replay is caught.
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1" })
      .mockRejectedValueOnce(new Error("second payload send failed"));

    // Drive the patch: entry lands in unknown_after_send.
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

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    // Reconnect drain with no adapter (cfg={}) — reconcileUnknownQueuedDelivery
    // returns null → "refusing blind replay" branch → deliver is never called.
    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
    // The entry is moved to failed (not re-queued as pending), closing the drain loop.
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
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
