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
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );
      const { id, reply } = await awaitCustodyReply(queued.promise, outcome);
      let failure: unknown;
      let committedArtifact = "";
      try {
        const committedPaths = await awaitCustodyReply(reply.held, outcome);
        expect(committedPaths).toHaveLength(1);
        committedArtifact = committedPaths[0]!;
        expect(path.dirname(committedArtifact)).toBe(path.join(stateDir, "delivery-queue-media"));
        expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
        await expect(fs.readFile(committedArtifact, "utf8")).resolves.toBe(
          "synthetic queued audio",
        );
        await reply.lose();
        const result = await outcome;
        expect(result).toHaveProperty("error");
        failure = "error" in result ? result.error : undefined;
        expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
          "outcome-unknown",
        );
        expect(reply.attempts()).toBe(1);
      } finally {
        reply.restore();
        reply.release();
        await outcome;
      }
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
      await closeOpenClawStateDatabaseAsync();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
      ).toBeUndefined();
      await expect(fs.readFile(committedArtifact, "utf8")).resolves.toBe("synthetic queued audio");
      const recover = vi.fn(deliverOutboundPayloads);
      await drainMatrixReconnect({ stateDir, deliver: recover });
      expect(recover).not.toHaveBeenCalled();
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
      committedClaim = await awaitCustodyReply(reply.held, outcome);
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
