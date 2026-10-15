import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import {
  enqueueDeliveryOnce,
  reserveDeliveryAttempt,
  markDeliveryPlatformSendAttemptStarted,
  markDeliveryPlatformOutcomeUnknown,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("recovered requester receipt safety", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  async function prepare(
    options: { refreshSuccessor?: boolean; payloads?: Array<{ text: string }> } = {},
  ) {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:receipt-safety",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const context = { channel: "matrix", to: "!original:example", threadId: "original-thread" };
    await replaceSessionEntry(scope, {
      sessionId: "session",
      lifecycleRevision: "lifecycle-a",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "run-a",
      restartRecoveryDeliverySourceRunId: "source-a",
      restartRecoveryDeliveryContext: context,
    });
    const entry = loadSessionEntry(scope)!;
    // This is the command's production admission owner, before model execution/cache publication.
    const admission = prepareAgentCommandExecutionIdentity({
      opts: { message: "finish the admitted task" },
      prepared: {
        cfg: {},
        runId: "run-a",
        sessionAgentId: "main",
        sessionId: entry.sessionId,
        sessionEntry: entry,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
      },
      ingress: { kind: "system", boundary: "receipt-safety-test", state: "present" },
      lifecycleGeneration: "test-generation",
    });
    const sessionStore = { [scope.sessionKey]: entry };
    if (options.refreshSuccessor) {
      await patchSessionEntryCore(scope, () => ({
        restartRecoveryDeliveryRunId: "run-b",
        restartRecoveryDeliverySourceRunId: "source-b",
      }));
      // Reproduce updateSessionStoreAfterAgentRun's onCommitted publication: both live cache and row are B.
      const cachedEntry = sessionStore[scope.sessionKey];
      const refreshedEntry = loadSessionEntry(scope);
      if (!cachedEntry || !refreshedEntry) {
        throw new Error("missing cache-refresh fixture entry");
      }
      Object.assign(cachedEntry, refreshedEntry);
    }
    const payloads = options.payloads ?? [{ text: "final output" }];
    let marker;
    try {
      marker = await persistPendingFinalDeliveryMarker({
        ...scope,
        deliver: true,
        sessionEntry: entry,
        sessionStore,
        storePath: scope.storePath,
        admittedRecoverySource: admission.pendingFinalRecoverySource,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: context,
        runOwnedSessionId: entry.sessionId,
      });
    } finally {
      admission.close();
    }
    return {
      scope,
      context,
      payloads,
      marker,
      completion: resolvePendingFinalDeliveryCompletion(payloads),
    };
  }

  it("does not bind finishing A to a refreshed same-session same-route successor B", async () => {
    const { scope, marker } = await prepare({ refreshSuccessor: true });
    expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(false);
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliveryRunId: "run-b",
      restartRecoveryDeliverySourceRunId: "source-b",
    });
    expect(loadSessionEntry(scope)?.pendingFinalDelivery).toBeUndefined();
  });

  it.each(["missing-identity", "wrong-target", "wrong-channel", "not-sent"] as const)(
    "requires evidence for earlier logical members: %s then valid",
    async (invalid) => {
      const { scope, context, completion } = await prepare();
      if (!completion) {
        throw new Error("missing completion");
      }
      await patchSessionEntryCore(scope, (entry) => ({
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          deliveries: [
            ...entry.pendingFinalDelivery!.deliveries!,
            { id: "second", state: "prepared" },
          ],
        },
      }));
      const first: OutboundDeliveryResult = {
        channel: invalid === "wrong-channel" ? "discord" : "matrix",
        messageId: invalid === "missing-identity" ? "" : "first",
        target: { kind: "room", id: invalid === "wrong-target" ? "!other:example" : context.to },
        ...(invalid === "not-sent" ? { outcome: "not_sent" as const } : {}),
      };
      await settlePendingFinalDelivery(completion, "delivered", undefined, {
        identifiedResult: first,
      });
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      await settlePendingFinalDelivery(
        { ...completion, deliveryId: "second" },
        "delivered",
        undefined,
        { identifiedResult: { channel: "matrix", messageId: "valid-last" } },
      );
      expect(
        getRestartRecoveryTerminalDeliveryEvidence(loadSessionEntry(scope), "source-a"),
      ).toBeUndefined();
      expect(
        getRestartRecoveryTerminalDeliveryEvidence(loadSessionEntry(scope), "source-b"),
      ).toBeUndefined();
    },
  );

  it.each(["recovery", "live"] as const)(
    "does not acknowledge invalid-first valid-last logical sends through %s custody",
    async (mode) => {
      const { scope, context, completion } = await prepare();
      if (!completion) {
        throw new Error("missing completion");
      }
      await patchSessionEntryCore(scope, (entry) => ({
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          deliveries: [
            ...entry.pendingFinalDelivery!.deliveries!,
            { id: "second", state: "prepared" },
          ],
        },
      }));
      const send = vi.fn(async (_to: string, text: string) => ({
        messageId: text + "-id",
        target: { kind: "room", id: text === "first" ? "!other:example" : context.to },
      }));
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
        });
      for (const [text, deliveryId] of [
        ["first", completion.deliveryId],
        ["second", "second"],
      ] as const) {
        const params = {
          cfg: {},
          ...context,
          payloads: [{ text }],
          deps: { matrix: send },
          queuePolicy: "required" as const,
          deliveryIntentId: deliveryId,
          deliveryCompletion: { ...completion, deliveryId },
        };
        if (mode === "live") {
          await deliverOutboundPayloads(params);
        } else {
          await enqueueDeliveryOnce(params, deliveryId, tmpDir);
          await recover();
        }
        await closeOpenClawAgentDatabasesAsync(tmpDir);
      }
      const entry = loadSessionEntry(scope);
      expect(entry?.pendingFinalDelivery?.deliveries).toMatchObject([
        { id: completion.deliveryId, state: "delivered" },
        { id: "second", state: "delivered" },
      ]);
      expect(entry?.pendingFinalDelivery?.deliveries?.[0]?.receipt).toBeUndefined();
      expect(getRestartRecoveryTerminalDeliveryEvidence(entry, "source-a")).toBeUndefined();
      expect(entry?.pendingFinalDelivery?.deliveries?.[1]?.receipt).toMatchObject({
        platformMessageId: "second-id",
      });
      await recover();
      expect(send).toHaveBeenCalledTimes(2);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  it.each(
    ["recovery", "live"].flatMap((mode) =>
      [false, true].map((suppressFirst) => ({ mode, suppressFirst })),
    ),
  )(
    "requires all physical command payloads ($mode, partial suppression: $suppressFirst)",
    async ({ mode, suppressFirst }) => {
      const { scope, context, payloads, completion } = await prepare({
        payloads: [{ text: "first" }, { text: "second" }],
      });
      if (!completion) {
        throw new Error("missing completion");
      }
      const send = vi.fn(async (_to: string, text: string) =>
        suppressFirst && text === "first"
          ? { messageId: "", outcome: "not_sent" }
          : { messageId: text + "-id" },
      );
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
        });
      if (mode === "live") {
        await deliverOutboundPayloads({
          cfg: {},
          ...context,
          payloads,
          deliveryCompletion: completion,
          deliveryIntentId: completion.deliveryId,
          queuePolicy: "required",
          deps: { matrix: send },
        });
      } else {
        await enqueueDeliveryOnce(
          { ...context, payloads, deliveryCompletion: completion },
          completion.deliveryId,
          tmpDir,
        );
        await recover();
      }
      const evidence = getRestartRecoveryTerminalDeliveryEvidence(
        loadSessionEntry(scope),
        "source-a",
      );
      if (suppressFirst) {
        expect(evidence).toBeUndefined();
      } else {
        expect(evidence).toMatchObject({
          deliveryStatus: { status: "sent", resultCount: 2 },
          durableFinalReceipt: { platformMessageId: "second-id" },
        });
      }
      await recover();
      expect(send).toHaveBeenCalledTimes(2);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  it.each([
    "nested-target",
    "mixed-parts",
    "receipt-thread",
    "part-thread",
    "matching",
    "normalized",
    "metadata-omitted",
  ] as const)("validates physical receipt routing through queue delivery: %s", async (variant) => {
    const { scope, context, payloads, completion } = await prepare();
    if (!completion) {
      throw new Error("missing completion");
    }
    const part = {
      platformMessageId: "first-id",
      kind: "text" as const,
      index: 0,
      threadId: context.threadId,
      raw: { roomId: context.to },
    };
    const receipt = {
      primaryPlatformMessageId: "first-id",
      platformMessageIds: ["first-id"],
      parts: [part],
      threadId: context.threadId,
      sentAt: 1,
      raw: [{ roomId: context.to }],
    };
    if (variant === "normalized") {
      receipt.raw[0]!.roomId = "  " + context.to + "  ";
      receipt.parts[0]!.raw.roomId = "  " + context.to + "  ";
    }
    if (variant === "nested-target") {
      receipt.raw[0]!.roomId = "!other:example";
    }
    if (variant === "mixed-parts") {
      receipt.parts.push({
        ...part,
        platformMessageId: "other-id",
        index: 1,
        raw: { roomId: "!other:example" },
      });
      receipt.platformMessageIds.push("other-id");
    }
    if (variant === "receipt-thread") {
      receipt.threadId = "other-thread";
    }
    if (variant === "part-thread") {
      receipt.parts[0]!.threadId = "other-thread";
    }
    await enqueueDeliveryOnce(
      { ...context, payloads, deliveryCompletion: completion },
      completion.deliveryId,
      tmpDir,
    );
    const send = vi
      .fn()
      .mockResolvedValue(
        variant === "metadata-omitted"
          ? { messageId: "first-id" }
          : { messageId: "first-id", target: { kind: "room", id: context.to }, receipt },
      );
    const recover = () =>
      recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir,
        log: createRecoveryLog(),
        deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
      });
    await recover();
    const evidence = getRestartRecoveryTerminalDeliveryEvidence(
      loadSessionEntry(scope),
      "source-a",
    );
    if (variant === "matching" || variant === "normalized" || variant === "metadata-omitted") {
      expect(evidence).toMatchObject({ durableFinalReceipt: { platformMessageId: "first-id" } });
    } else {
      expect(evidence).toBeUndefined();
    }
    await recover();
    expect(send).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });
  it.each([1, 2])(
    "does not infer complete physical batches from reconciliation (%s payloads)",
    async (count) => {
      const { scope, context, payloads, completion } = await prepare({
        payloads: Array.from({ length: count }, (_, index) => ({ text: "part-" + index })),
      });
      if (!completion) {
        throw new Error("missing completion");
      }
      const reconcile = vi.fn(async () => ({
        status: "sent" as const,
        receipt: {
          primaryPlatformMessageId: "reconciled-id",
          platformMessageIds: ["reconciled-id"],
          parts: [{ platformMessageId: "reconciled-id", kind: "text" as const, index: 0 }],
          sentAt: 1,
        },
      }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
              message: {
                id: "matrix",
                send: {
                  text: async () => {
                    throw new Error("reconciliation must not send again");
                  },
                },
                durableFinal: {
                  capabilities: { reconcileUnknownSend: true },
                  reconcileUnknownSend: reconcile,
                },
              },
            },
          },
        ]),
      );
      await enqueueDeliveryOnce(
        { ...context, payloads, deliveryCompletion: completion },
        completion.deliveryId,
        tmpDir,
      );
      await reserveDeliveryAttempt(completion.deliveryId, 1, tmpDir);
      await markDeliveryPlatformSendAttemptStarted(completion.deliveryId, tmpDir);
      await markDeliveryPlatformOutcomeUnknown(completion.deliveryId, tmpDir);
      const deliver = vi.fn(async () => []);
      const recover = () =>
        recoverPendingDeliveries({ cfg: {}, stateDir: tmpDir, log: createRecoveryLog(), deliver });
      await recover();
      const evidence = getRestartRecoveryTerminalDeliveryEvidence(
        loadSessionEntry(scope),
        "source-a",
      );
      if (count === 1) {
        expect(evidence).toMatchObject({
          durableFinalReceipt: { platformMessageId: "reconciled-id" },
        });
      } else {
        expect(evidence).toBeUndefined();
      }
      await recover();
      expect(deliver).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );
});
