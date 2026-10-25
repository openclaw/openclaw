import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import {
  awaitCustodyReply,
  installCustodyMatrixPlugin,
} from "./delivery-queue-custody.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  holdAcknowledgementReply,
  holdDeliveryQueueReply,
} from "./delivery-queue-worker-reply.test-support.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("outbound custody reply loss", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function createArtifact(stateDir: string, extension: "txt" | "ogg") {
    const artifact = path.join(
      stateDir,
      "delivery-queue-media",
      `00000000-0000-4000-8000-000000000001.${extension}`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic queued audio");
    return artifact;
  }

  const expectMedia = (artifact: string) =>
    expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic queued audio");

  async function loseReply<T>(
    reply: ReturnType<typeof holdDeliveryQueueReply<T>>,
    outcome: Promise<unknown>,
    inspect: (value: T) => Promise<void> = async () => {},
  ) {
    try {
      const value = await awaitCustodyReply(reply.held, outcome);
      await inspect(value);
      await reply.lose();
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
        "outcome-unknown",
      );
      expect(reply.attempts()).toBe(1);
      return value;
    } finally {
      reply.restore();
      reply.release();
      await outcome;
    }
  }

  it.each(["pre-send fallback", "post-send settlement"] as const)(
    "does not replay a committed %s or release unacknowledged media",
    async (phase) => {
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const artifact = await createArtifact(stateDir, "txt");
      installCustodyMatrixPlugin(matrixOutboundForQueueTest);
      if (phase === "pre-send fallback") {
        vi.spyOn(queueStorage, "markDeliveryPlatformSendAttemptStarted").mockRejectedValueOnce(
          new Error("synthetic marker failure"),
        );
      }
      const send = vi.fn(async () => ({ messageId: "synthetic-sent" }));
      const queued = createDeferredCore<{
        id: string;
        reply: ReturnType<typeof holdAcknowledgementReply>;
      }>();
      const outcome = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "synthetic delivery", mediaUrl: artifact }],
        queuePolicy: phase === "pre-send fallback" ? "best_effort" : "required",
        requireUnknownSendReconciliation: false,
        deps: { matrix: send },
        onDeliveryIntent: ({ id }) => queued.resolve({ id, reply: holdAcknowledgementReply(id) }),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const { id, reply } = await awaitCustodyReply(queued.promise, outcome);
      const committedPaths = await loseReply(reply, outcome, async (paths) => {
        expect(paths).toHaveLength(1);
        const committedArtifact = paths[0]!;
        expect(path.dirname(committedArtifact)).toBe(path.join(stateDir, "delivery-queue-media"));
        expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
        await expectMedia(committedArtifact);
      });
      const committedArtifact = committedPaths[0]!;
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
      await closeOpenClawStateDatabaseAsync();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
      ).toBeUndefined();
      await expectMedia(committedArtifact);
      await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
    },
  );

  it("retains committed claim custody and media until a later explicit recovery", async () => {
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const id = "cron-direct-delivery:v1:claim-reply-loss";
    const artifact = await createArtifact(stateDir, "ogg");
    installCustodyMatrixPlugin(matrixOutboundForQueueTest);
    await queueStorage.enqueueDeliveryOnce(
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
      await expectMedia(artifact);
      return { messageId: "recovered-after-claim-expiry" };
    });
    const deliver: DeliverFn = (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } });
    const recover = () => drainMatrixReconnect({ deliver, stateDir });
    const reply = holdDeliveryQueueReply("deliveryQueue.claimPlatformSend", id, (value) =>
      typeof value === "string" ? value : undefined,
    );
    const outcome = recover().then(
      () => undefined,
      (error: unknown) => error,
    );
    const committedClaim = await loseReply(reply, outcome);
    expect(committedClaim).toEqual(expect.any(String));
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
    await expectMedia(artifact);
    await recover();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(readQueuedEntry(stateDir, id)).toEqual(retained);
    await expectMedia(artifact);
    setQueuedEntryState(stateDir, id, { retryCount: 0, availableAt: Date.now() - 1 });
    await recover();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir)).toBe(
      "completed",
    );
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    await recover();
    expect(sendMatrix).toHaveBeenCalledOnce();
  });
});
