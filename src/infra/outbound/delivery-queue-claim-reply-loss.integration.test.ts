import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import type { SqliteWorkerRequest } from "../sqlite-worker-contract.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

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
    let claimThreadId: number | undefined;
    let requestId: number | undefined;
    let committedClaim: string | undefined;
    let terminated: Promise<number> | undefined;
    let attempts = 0;
    // oxlint-disable-next-line typescript/unbound-method -- The saved method retains the intercepted worker receiver.
    const originalPost = Worker.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply retains the intercepted worker receiver.
    const originalEmit = Worker.prototype.emit;
    const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (
          command &&
          typeof command === "object" &&
          "type" in command &&
          command.type === "deliveryQueue.claimPlatformSend" &&
          "input" in command &&
          command.input &&
          typeof command.input === "object" &&
          "id" in command.input &&
          command.input.id === id
        ) {
          claimThreadId = this.threadId;
          requestId = request.id;
          attempts += 1;
        }
      }
      return originalPost.call(this, request, transferList);
    });
    const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const reply = args[0];
      if (
        committedClaim === undefined &&
        this.threadId === claimThreadId &&
        event === "message" &&
        reply &&
        typeof reply === "object" &&
        "id" in reply &&
        reply.id === requestId &&
        "ok" in reply &&
        reply.ok === true &&
        "value" in reply &&
        reply.value instanceof Uint8Array
      ) {
        const result: unknown = deserialize(reply.value);
        if (typeof result === "string") {
          // Drop only a committed claim's successful reply, then join native exit.
          committedClaim = result;
          terminated = this.terminate();
          return false;
        }
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    let failure: unknown;
    try {
      failure = await recover().then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      post.mockRestore();
      emit.mockRestore();
      await terminated;
    }
    expect(committedClaim).toEqual(expect.any(String));
    expect(attempts).toBe(1);
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
