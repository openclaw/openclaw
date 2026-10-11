import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { holdDeliveryQueueReply } from "./delivery-queue-worker-reply.test-support.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

// Claim reply-loss recovery does not own destination transcript persistence.
vi.mock("../../sessions/confirmed-visible-message.js", () => ({
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
}));

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("recovery claim reply loss", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("retains committed claim custody and media until a later explicit recovery", async () => {
    const stateDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const id = "cron-direct-delivery:v1:claim-reply-loss";
    const artifact = path.join(
      stateDir,
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000001.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic queued audio");
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "recover once", mediaUrl: artifact }],
        queuePolicy: "required",
        requiresProducerClaim: true,
        completionRetention: boundedCronCompletionRetention,
        maxRetries: 2,
      },
      id,
      stateDir,
    );
    const before = readQueuedEntry(stateDir, id);
    const sendMatrix = vi.fn(async () => {
      await expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic queued audio");
      return { messageId: "recovered-after-claim-expiry" };
    });
    const deliver = vi.fn<DeliverFn>((params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );
    const recover = () => drainMatrixReconnect({ deliver, stateDir });
    const reply = holdDeliveryQueueReply("deliveryQueue.claimPlatformSend", id, (value) =>
      typeof value === "string" ? value : undefined,
    );
    const outcome = recover().then(
      () => undefined,
      (error: unknown) => error,
    );
    let committedClaim: string;
    let failure: unknown;
    try {
      committedClaim = await Promise.race([
        reply.held,
        outcome.then((error) => {
          throw new Error("Recovery settled before its committed claim reply", { cause: error });
        }),
      ]);
      await reply.lose();
      failure = await outcome;
      expect(reply.attempts()).toBe(1);
    } finally {
      reply.restore();
      reply.release();
      await outcome;
    }
    expect(committedClaim).toEqual(expect.any(String));
    expect(failure).toBeInstanceOf(Error);
    expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
      "outcome-unknown",
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    await closeOpenClawStateDatabaseAsync();
    const retained = readQueuedEntry(stateDir, id);
    expect(retained).toEqual({
      ...before,
      recoveryState: "producer_claimed",
      producerClaimId: committedClaim,
      availableAt: expect.any(Number),
    });
    expect(retained.availableAt as number).toBeGreaterThan(Date.now());
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic queued audio");

    await recover();
    expect(deliver).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(readQueuedEntry(stateDir, id)).toEqual(retained);
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic queued audio");

    setQueuedEntryState(stateDir, id, { retryCount: 0, availableAt: Date.now() - 1 });
    await recover();
    expect(deliver).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir)).toBe(
      "completed",
    );
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    await recover();
    expect(sendMatrix).toHaveBeenCalledOnce();
  });
});
