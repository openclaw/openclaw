import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "../delivery-queue-sqlite.test-support.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME as LEGACY_QUEUE,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME as MIGRATION_QUEUE,
  OUTBOUND_DELIVERY_QUEUE_NAME as PREPARED_QUEUE,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME as PREPARATION_QUEUE,
} from "./delivery-queue-media-staging.js";
import { migrateLegacyPendingOutboundDeliveries } from "./delivery-queue-migration.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDelivery,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
  type LegacyQueuedDelivery,
  type LegacyQueuedDeliveryPreparation,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

const hookMocks = vi.hoisted(() => ({
  hasHooks: vi.fn((name?: string) => name === "message_sending" || name === "message_sent"),
  runMessageSending: vi.fn(async (event: { content: string }) => ({
    content: `${event.content}-prepared`,
  })),
  runMessageSent: vi.fn(async () => undefined),
}));
const channelMocks = vi.hoisted(() => ({
  resolveOutboundChannelMessageAdapter: vi.fn(),
}));
const completionMocks = vi.hoisted(() => ({
  settleUnknownDelivery: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks,
}));
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: channelMocks.resolveOutboundChannelMessageAdapter,
}));
vi.mock("./delivery-completion.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./delivery-completion.js")>();
  return {
    ...original,
    settleDurableDelivery: (...args: Parameters<typeof original.settleDurableDelivery>) =>
      "platformSendStarted" in args[1] && args[1].platformSendStarted
        ? completionMocks.settleUnknownDelivery(...args)
        : original.settleDurableDelivery(...args),
  };
});

const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text, deps }) => {
    const send = deps?.matrix as
      | ((to: string, text: string) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("missing Matrix sender");
    }
    return { channel: "matrix", ...(await send(to, text)) };
  },
};

function legacyEntry(id: string, text: string) {
  return {
    id,
    enqueuedAt: 100,
    retryCount: 0,
    attemptCount: 0,
    channel: "matrix" as const,
    to: "!room:example",
    queuePolicy: "required" as const,
    payloads: [{ text }],
  };
}

function readQueueEntryJson(queueName: string, id: string, stateDir: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return (
    db
      .prepare("SELECT entry_json FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(queueName, id) as { entry_json?: string } | undefined
  )?.entry_json;
}

describe("outbound prepared queue migration", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const migrate = (
    log: Parameters<typeof migrateLegacyPendingOutboundDeliveries>[0]["log"] = createRecoveryLog(),
  ) => migrateLegacyPendingOutboundDeliveries({ cfg: {}, log, stateDir: tmpDir() });
  const recover = (deliver: Parameters<typeof recoverPendingDeliveries>[0]["deliver"]) =>
    recoverPendingDeliveries({ cfg: {}, log: createRecoveryLog(), stateDir: tmpDir(), deliver });

  const preparedPayloads = (entry: QueuedDelivery) =>
    acceptedPreparedOutboundEntries(entry.preparedBatch).map((item) => item.payload);
  const seed = (queueName: string, entry: Parameters<typeof seedDeliveryQueueEntry>[0]["entry"]) =>
    seedDeliveryQueueEntry({ queueName, entry, stateDir: tmpDir() });
  const readEntry = (queue: string, id: string) => loadDeliveryQueueEntry(queue, id, tmpDir());
  const entryStatus = (queue: string, id: string) =>
    getDeliveryQueueEntryStatus(queue, id, tmpDir());
  const readJson = (queue: string, id: string) => readQueueEntryJson(queue, id, tmpDir());
  const recoverMatrix = (
    matrix: NonNullable<Parameters<typeof deliverOutboundPayloadsInternal>[0]["deps"]>["matrix"],
  ) => recover((params) => deliverOutboundPayloadsInternal({ ...params, deps: { matrix } }));
  function seedUnknown(
    id: string,
    recoveryState: "unknown_after_send" | "send_attempt_started",
    attempt: string,
    startedAt?: number,
    text = "pre-policy",
  ) {
    seed(LEGACY_QUEUE, {
      ...legacyEntry(id, text),
      recoveryState,
      platformSendAttemptId: attempt,
      ...(startedAt === undefined ? {} : { platformSendStartedAt: startedAt }),
    });
  }
  function installReconciler(reconcileUnknownSend: unknown) {
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: { capabilities: { reconcileUnknownSend: true }, reconcileUnknownSend },
    });
  }

  beforeEach(() => {
    hookMocks.hasHooks.mockClear();
    hookMocks.runMessageSending.mockClear();
    hookMocks.runMessageSending.mockImplementation(async (event: { content: string }) => ({
      content: `${event.content}-prepared`,
    }));
    hookMocks.runMessageSent.mockClear();
    channelMocks.resolveOutboundChannelMessageAdapter.mockReset();
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue(undefined);
    completionMocks.settleUnknownDelivery.mockClear();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutbound }),
        },
      ]),
    );
  });

  it("prepares a legacy row once, fences rollback, and never reruns modifiers", async () => {
    const id = "stable-legacy-delivery";
    const source = {
      ...legacyEntry(id, "secret"),
      completionRetention: "permanent",
      replyToId: "root-message",
      replyToMode: "batched",
    } satisfies LegacyQueuedDelivery;
    seed(LEGACY_QUEUE, source);

    await expect(migrate()).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledTimes(1);
    expect(entryStatus(LEGACY_QUEUE, id)).toBe("completed");
    expect(readJson(LEGACY_QUEUE, id)).not.toContain("secret");
    const queued = readEntry(PREPARED_QUEUE, id) as QueuedDelivery;
    expect(preparedPayloads(queued)).toEqual([{ text: "secret-prepared" }]);
    expect(queued.reply).toEqual({
      source: "implicit",
      replyToId: "root-message",
      mode: "first",
    });
    expect(queued).not.toHaveProperty("replyToId");
    expect(queued).not.toHaveProperty("replyToMode");
    expect(queued).not.toHaveProperty("legacyPreparationOwnerId");
    expect(queued).not.toHaveProperty("legacyPreparationLeaseExpiresAt");

    const sendMatrix = vi.fn(async () => ({ messageId: "mx-1" }));
    await recoverMatrix(sendMatrix);
    expect(hookMocks.runMessageSending).toHaveBeenCalledTimes(1);
    expect(sendMatrix).toHaveBeenCalledWith("!room:example", "secret-prepared");
    expect(hookMocks.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "secret-prepared",
        messageId: "mx-1",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(entryStatus(PREPARED_QUEUE, id)).toBe("completed");
  });

  it("claims a legacy row before invoking modifiers", async () => {
    const id = "claimed-legacy-delivery";
    const source = legacyEntry(id, "first");
    seed(LEGACY_QUEUE, source);
    const hook = createDeferredCore<{ content: string }>();
    hookMocks.runMessageSending.mockImplementationOnce(() => hook.promise);
    const migration = migrate();
    await vi.waitFor(() => expect(hookMocks.runMessageSending).toHaveBeenCalledOnce());
    const overlappingMigration = migrate();
    let overlappingSettled = false;
    void overlappingMigration.then(
      () => {
        overlappingSettled = true;
      },
      () => {
        overlappingSettled = true;
      },
    );
    await Promise.resolve();
    expect(overlappingSettled).toBe(false);
    expect(readEntry(LEGACY_QUEUE, id)).toBeNull();
    expect(readEntry(PREPARATION_QUEUE, id)).toMatchObject({
      legacyPreparationState: "modifiers_started",
      retainOnFailure: true,
      payloads: [{ text: "first" }],
    });
    hook.resolve({ content: "first-prepared" });

    await expect(migration).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    await expect(overlappingMigration).resolves.toEqual({
      moved: 1,
      skipped: 0,
      remaining: 0,
    });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(readEntry(PREPARATION_QUEUE, id)).toBeNull();
    expect(readEntry(PREPARED_QUEUE, id)).toMatchObject({
      preparedBatch: {
        entries: [expect.objectContaining({ payload: { text: "first-prepared" } })],
      },
    });
  });

  it("dead-letters interrupted modifier preparation without invoking hooks again", async () => {
    const id = "interrupted-legacy-preparation";
    const interrupted = {
      ...legacyEntry(id, "must not be reconsidered"),
      legacyPreparationState: "modifiers_started",
      retainOnFailure: true,
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "interrupted-operation",
      },
    } satisfies LegacyQueuedDeliveryPreparation;
    seed(PREPARATION_QUEUE, interrupted);

    await expect(migrate()).resolves.toEqual({ moved: 0, skipped: 1, remaining: 0 });

    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(completionMocks.settleUnknownDelivery).toHaveBeenCalledWith(
      interrupted.deliveryCompletion,
      { platformSendStarted: true },
      tmpDir(),
    );
    expect(entryStatus(PREPARATION_QUEUE, id)).toBe("failed");
    const failedFence = readJson(PREPARATION_QUEUE, id);
    expect(failedFence).toBeDefined();
    expect(failedFence).not.toContain("must not be reconsidered");
    const failedEntry = JSON.parse(failedFence ?? "{}") as Record<string, unknown>;
    expect(failedEntry).toMatchObject({
      id,
      enqueuedAt: expect.any(Number),
      retryCount: 0,
    });
    expect(failedEntry.enqueuedAt).toBe(failedEntry.failedAt);
    expect(failedEntry).not.toHaveProperty("payloads");
    expect(failedEntry).not.toHaveProperty("deliveryCompletion");
    expect(readEntry(PREPARED_QUEUE, id)).toBeNull();
  });

  it("does not dead-letter an actively leased modifier preparation", async () => {
    const id = "active-legacy-preparation";
    const active = {
      ...legacyEntry(id, "active raw input"),
      legacyPreparationState: "modifiers_started",
      retainOnFailure: true,
      legacyPreparationOwnerId: "other-process",
      legacyPreparationLeaseExpiresAt: Date.now() + 60_000,
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "active-operation",
      },
    } satisfies LegacyQueuedDeliveryPreparation;
    seed(PREPARATION_QUEUE, active);

    await expect(migrate()).resolves.toEqual({ moved: 0, skipped: 1, remaining: 1 });

    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(completionMocks.settleUnknownDelivery).not.toHaveBeenCalled();
    expect(entryStatus(PREPARATION_QUEUE, id)).toBe("pending");
    expect(readEntry(PREPARATION_QUEUE, id)).toEqual(active);
  });

  it("retries setup failures that occur before the first modifier invocation", async () => {
    const id = "legacy-pre-modifier-setup-failure";
    seed(LEGACY_QUEUE, legacyEntry(id, "retry after setup"));
    hookMocks.hasHooks.mockImplementationOnce(() => {
      throw new Error("transient hook registry failure");
    });

    await expect(migrate()).resolves.toEqual({ moved: 0, skipped: 1, remaining: 1 });
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(readEntry(PREPARATION_QUEUE, id)).toMatchObject({
      legacyPreparationState: "claimed",
      retainOnFailure: true,
    });

    hookMocks.hasHooks.mockImplementation(
      (name?: string) => name === "message_sending" || name === "message_sent",
    );
    await expect(migrate()).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(readEntry(PREPARED_QUEUE, id)).toMatchObject({
      preparedBatch: {
        entries: [expect.objectContaining({ payload: { text: "retry after setup-prepared" } })],
      },
    });
  });

  it("checkpoints prepared policy before retrying failed media staging", async () => {
    const id = "legacy-staging-retry";
    const source = path.join(
      tmpDir(),
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000091.png",
    );
    const sourceEntry = {
      ...legacyEntry(id, "caption"),
      payloads: [{ text: "caption", mediaUrl: source }],
    };
    const warnings: string[] = [];
    const log = {
      info: vi.fn(),
      warn: (message: string) => warnings.push(message),
      error: vi.fn(),
    };
    seed(LEGACY_QUEUE, sourceEntry);

    await expect(migrate(log)).resolves.toEqual({ moved: 0, skipped: 1, remaining: 1 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(readEntry(LEGACY_QUEUE, id)).toBeNull();
    expect(readEntry(MIGRATION_QUEUE, id)).toMatchObject({
      preparedBatch: {
        entries: [
          expect.objectContaining({
            status: "accepted",
            payload: { text: "caption-prepared", mediaUrl: source },
          }),
        ],
      },
    });

    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(
      source,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKJkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    warnings.length = 0;
    const secondMigration = await migrate(log);
    expect({ secondMigration, warnings }).toEqual({
      secondMigration: { moved: 1, skipped: 0, remaining: 0 },
      warnings: [],
    });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(readEntry(MIGRATION_QUEUE, id)).toBeNull();
    expect(readEntry(PREPARED_QUEUE, id)).toMatchObject({
      preparedBatch: {
        entries: [
          expect.objectContaining({
            status: "accepted",
            payload: expect.objectContaining({ text: "caption-prepared" }),
          }),
        ],
      },
      renderedBatchPlan: {
        items: [expect.objectContaining({ mediaUrls: [source] })],
      },
    });
  });

  it("reconciles a legacy unknown send before modifiers and prepares only when not sent", async () => {
    const id = "legacy-pre-send-reconcile";
    seedUnknown(id, "send_attempt_started", "attempt-1", 200, "original");
    const reconciliation = createDeferredCore<{ status: "not_sent" }>();
    const reconcileUnknownSend = vi.fn(() => reconciliation.promise);
    installReconciler(reconcileUnknownSend);

    const migration = migrate();
    await vi.waitFor(() => expect(reconcileUnknownSend).toHaveBeenCalledOnce());
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    reconciliation.resolve({ status: "not_sent" });

    await expect(migration).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    const queued = readEntry(PREPARED_QUEUE, id) as QueuedDelivery;
    expect(queued.legacyUnknownSendReconciliation).toBeUndefined();
    expect(queued.recoveryState).toBeUndefined();
    expect(queued.platformSendAttemptId).toBeUndefined();
    expect(queued.platformSendStartedAt).toBeUndefined();
    expect(preparedPayloads(queued)).toEqual([{ text: "original-prepared" }]);

    const deliver = vi.fn().mockResolvedValue([{ channel: "matrix", messageId: "mx-new-attempt" }]);
    await recover(deliver);
    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("settles a reconciled-sent legacy row without rerunning modifiers or provider I/O", async () => {
    const id = "legacy-already-sent";
    seedUnknown(id, "unknown_after_send", "attempt-sent", 200);
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId: "mx-existing" }],
      kind: "text",
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "sent",
      messageId: "mx-existing",
      receipt,
    });
    installReconciler(reconcileUnknownSend);

    await expect(migrate()).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    const migrated = readEntry(PREPARED_QUEUE, id) as QueuedDelivery;
    expect(migrated.preparedBatch).toMatchObject({ sourcePayloadCount: 1, entries: [] });
    expect(readJson(PREPARED_QUEUE, id)).not.toContain("pre-policy");

    const sendMatrix = vi.fn();
    await recoverMatrix(sendMatrix);

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runMessageSent).not.toHaveBeenCalled();
    expect(entryStatus(PREPARED_QUEUE, id)).toBeUndefined();
  });

  it("emits one terminal observer event for every payload in a reconciled batch", async () => {
    const id = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [{ text: "first prepared" }, { text: "second prepared" }],
      },
      tmpDir(),
    );
    await reserveDeliveryAttempt(id, 1, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "matrix", messageId: "mx-first" },
        { channel: "matrix", messageId: "mx-second" },
      ],
      kind: "text",
    });
    installReconciler(
      vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "mx-first",
        receipt,
      }),
    );

    await recover(vi.fn());

    expect(hookMocks.runMessageSent.mock.calls).toMatchObject([
      [
        { content: "first prepared", messageId: "mx-first", success: true },
        { channelId: "matrix" },
      ],
      [
        { content: "second prepared", messageId: "mx-second", success: true },
        { channelId: "matrix" },
      ],
    ]);
  });

  it("fills the unattempted observer suffix when recovery dead-letters a batch", async () => {
    await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [{ text: "sent" }, { text: "failed" }, { text: "unattempted" }],
      },
      tmpDir(),
    );
    const deliver = vi.fn(async (params: Parameters<typeof deliverOutboundPayloadsInternal>[0]) => {
      params.onMessageSentEvent?.(
        {
          success: true,
          content: "sent",
          messageId: "mx-sent",
        },
        0,
      );
      params.onMessageSentEvent?.(
        {
          success: false,
          content: "failed",
          error: "chat not found",
        },
        1,
      );
      throw new Error("chat not found");
    });

    await recover(deliver);

    expect(hookMocks.runMessageSent.mock.calls).toMatchObject([
      [{ content: "sent", messageId: "mx-sent", success: true }, expect.any(Object)],
      [{ content: "failed", success: false }, expect.any(Object)],
      [{ content: "unattempted", success: false }, expect.any(Object)],
    ]);
  });

  it("dead-letters a partially-sent legacy row even when reconciliation reports not sent", async () => {
    const id = "legacy-partial-not-sent";
    seedUnknown(id, "unknown_after_send", "attempt-partial", 200);
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    installReconciler(reconcileUnknownSend);
    const sendMatrix = vi.fn();

    await expect(migrate()).resolves.toEqual({ moved: 1, skipped: 0, remaining: 0 });
    await recoverMatrix(sendMatrix);

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runMessageSent).not.toHaveBeenCalled();
    expect(entryStatus(PREPARED_QUEUE, id)).toBe("failed");
    expect(readJson(PREPARED_QUEUE, id)).not.toContain("pre-policy");
  });

  it("fails unresolved legacy custody payload-free without running modifiers", async () => {
    const id = "legacy-unresolved";
    seedUnknown(id, "send_attempt_started", "attempt-unresolved");
    installReconciler(
      vi.fn().mockResolvedValue({
        status: "unresolved",
        error: "provider unavailable",
        retryable: true,
      }),
    );

    await expect(migrate()).resolves.toEqual({ moved: 0, skipped: 1, remaining: 0 });
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(readEntry(PREPARED_QUEUE, id)).toBeNull();
    expect(readEntry(LEGACY_QUEUE, id)).toBeNull();
    expect(entryStatus(PREPARATION_QUEUE, id)).toBe("failed");
    expect(readJson(PREPARATION_QUEUE, id)).not.toContain("pre-policy");
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
});
