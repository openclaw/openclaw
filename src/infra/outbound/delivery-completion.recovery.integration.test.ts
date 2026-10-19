import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMainSessionRecoverySettlementPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { capturePendingFinalRecoverySource } from "../../agents/pending-final-recovery-source.js";
import { resolveRequesterRecoveryDelivery } from "../../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { createDirectAnnounceResponseClassifier } from "../../agents/subagents/announce/subagent-announce-direct-response.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAgentTurnCompletion } from "../../auto-reply/reply/agent-runner-completion.js";
import { clearPendingFinalDeliveryAfterSuccess } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { settlePendingFinalDelivery } from "./delivery-completion.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("recovered requester final receipts", () => {
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

  it.each([
    { producer: "command", terminalBeforeDelivery: false },
    { producer: "command", terminalBeforeDelivery: true },
    { producer: "reply", terminalBeforeDelivery: false },
    { producer: "reply", terminalBeforeDelivery: true },
  ] as const)(
    "retains a recovered subagent final after queue restart ($producer, terminal: $terminalBeforeDelivery)",
    async ({ producer, terminalBeforeDelivery }) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:recovered-requester",
        storePath: path.join(tmpDir, "sessions.json"),
      };
      const sourceRunId = "subagent-settle:completed-child:generation:1";
      const recoveryRunId = "recovered-requester-run";
      const context = { channel: "matrix", to: "!original:example" };
      await replaceSessionEntry(scope, {
        sessionId: "requester-session",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: recoveryRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoveryDeliveryContext: context,
        restartRecoverySourceIngress: "channel",
      });
      const entry = loadSessionEntry(scope)!;
      const payload = {
        text: "Completed child result, synthesized by the recovered requester.",
      };
      const payloads = [payload];
      if (producer === "command") {
        await persistPendingFinalDeliveryMarker({
          admittedRecoverySource: capturePendingFinalRecoverySource(entry),
          ...scope,
          deliver: true,
          sessionStore: { [scope.sessionKey]: entry },
          sessionEntry: entry,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads,
          deliveryContext: context,
          runOwnedSessionId: entry.sessionId,
        });
      } else {
        const operation = createReplyOperation({
          target: captureSessionTarget({
            storeScope: scope.storePath,
            sessionKey: scope.sessionKey,
            incarnation: entry.sessionId,
            agentId: scope.agentId,
          }),
          sessionId: entry.sessionId,
          sessionKey: scope.sessionKey,
          resetTriggered: false,
        });
        try {
          await withAgentTurnCompletion(
            { ...scope, entry, operation, publish() {} },
            async (owner) => {
              await owner!.complete({
                kind: "replayable",
                text: payload.text,
                createdAt: 1,
                context,
                intentId: "reply-intent",
                deliveries: [{ id: "reply-delivery", state: "prepared" }],
              });
            },
          );
          setReplyPayloadMetadata(payload, {
            pendingFinalDeliveryCompletion: {
              ...scope,
              sessionId: entry.sessionId,
              recoveryRunId,
              intentId: "reply-intent",
              deliveryId: "reply-delivery",
            },
          });
        } finally {
          operation.complete();
        }
      }
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      if (!completion) {
        throw new Error("Expected the recovered requester's final delivery owner");
      }
      await enqueueDeliveryOnce(
        { ...context, payloads, deliveryCompletion: completion },
        completion.deliveryId,
        tmpDir,
      );
      if (terminalBeforeDelivery) {
        await patchSessionEntryCore(scope, (current) => ({
          ...buildMainSessionRecoverySettlementPatch({
            entry: current,
            recordTerminalSource: true,
            terminalRunId: recoveryRunId,
            terminalDeliveryEvidence: { captured: true },
          }),
          status: "done",
        }));
      }
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      await closeStateDatabaseForTest();
      const sendMatrix = vi.fn().mockResolvedValue({ messageId: "recovered-final-message" });
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
        });
      await recover();
      await clearPendingFinalDeliveryAfterSuccess(completion);
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      const settled = loadSessionEntry(scope);
      expect(settled?.pendingFinalDelivery).toBeUndefined();
      expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
      expect(getRestartRecoveryTerminalDeliveryEvidence(settled, sourceRunId)).toMatchObject({
        runId: sourceRunId,
        deliveryContext: context,
        deliveryStatus: { status: "sent", resultCount: 1 },
        durableFinalReceipt: {
          intentId: completion.intentId,
          deliveryId: completion.deliveryId,
          platformMessageId: "recovered-final-message",
        },
      });
      const recovered = resolveRequesterRecoveryDelivery(settled, sourceRunId);
      expect(recovered?.kind).toBe("result");
      if (recovered?.kind !== "result") {
        throw new Error("Expected durable source evidence for reconciliation");
      }
      const classify = createDirectAnnounceResponseClassifier({
        params: {
          sourceTool: "subagent_settle",
          expectsCompletionMessage: true,
          requesterIsSubagent: false,
        },
        parentOnly: false,
        requesterSessionBound: true,
        replyExpectation: "required",
        deliveryTarget: context,
        shouldDeliverAgentFinal: true,
        requiresMessageToolDelivery: false,
        isSubagentCompletion: true,
        hasSuccessfulTrustedSubagentNoOutputCompletion: false,
        hasRequiredSubagentNoOutputCompletion: false,
        subagentDirectMessageCompletionRequiresMessageTool: false,
        effectiveDirectOrigin: context,
        requesterSessionOrigin: context,
        textCompletionDirectDeliveryKind: "completed_result",
        tryTextCompletionDirectDelivery: async () => undefined,
      });
      expect(await classify({ status: "ok", result: recovered.result })).toMatchObject({
        delivered: true,
      });
      // A later metadata rewrite carrying the pre-send capture must not erase the committed receipt.
      await patchSessionEntryCore(scope, () => ({
        restartRecoveryTerminalDeliveryEvidence: [
          recovered.result,
          { runId: sourceRunId, captured: true },
        ],
      }));
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      expect(
        getRestartRecoveryTerminalDeliveryEvidence(loadSessionEntry(scope), sourceRunId),
      ).toEqual(recovered.result);
      expect(getRestartRecoveryTerminalDeliveryEvidence(settled, recoveryRunId)).toBeUndefined();
      expect(getRestartRecoveryTerminalDeliveryEvidence(settled, "later-source")).toBeUndefined();
      await recover();
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  async function prepareFinal(
    options: {
      captureContext?: { channel: string; to: string; accountId?: string; threadId?: string };
      replaceSourceBeforeCapture?: boolean;
    } = {},
  ) {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:receipt-control",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const context = { channel: "matrix", to: "!original:example" };
    const sourceRunId = "original-source";
    await replaceSessionEntry(scope, {
      sessionId: "session",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "recovery",
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoveryDeliveryContext: context,
    });
    const entry = loadSessionEntry(scope)!;
    if (options.replaceSourceBeforeCapture) {
      await patchSessionEntryCore(scope, () => ({
        restartRecoveryDeliveryRunId: "later-run",
        restartRecoveryDeliverySourceRunId: "later-source",
      }));
    }
    const payloads = [{ text: "The final result." }];
    await persistPendingFinalDeliveryMarker({
      admittedRecoverySource: capturePendingFinalRecoverySource(entry),
      ...scope,
      deliver: true,
      sessionStore: { [scope.sessionKey]: entry },
      sessionEntry: entry,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads,
      deliveryContext: options.captureContext ?? context,
      runOwnedSessionId: entry.sessionId,
    });
    const completion = resolvePendingFinalDeliveryCompletion(payloads);
    if (!completion && !options.replaceSourceBeforeCapture) {
      throw new Error("Expected final custody");
    }
    return { scope, context, sourceRunId, completion };
  }

  it.each([
    "missing-identity",
    "wrong-channel",
    "wrong-target",
    "not-sent",
    "suppressed",
    "unknown",
    "queued",
    "session-reset",
    "intent-replaced",
  ] as const)("does not acknowledge the original source after %s", async (condition) => {
    const { scope, context, sourceRunId, completion } = await prepareFinal();
    if (!completion) {
      throw new Error("Expected final custody");
    }
    const result: OutboundDeliveryResult = {
      channel: "matrix",
      messageId: "provider-id",
      target: { kind: "room", id: context.to },
    };
    let state: Parameters<typeof settlePendingFinalDelivery>[1] = "delivered";
    if (condition === "missing-identity") {
      result.messageId = " ";
    }
    if (condition === "wrong-channel") {
      result.channel = "discord";
    }
    if (condition === "wrong-target") {
      result.target!.id = "!unrelated:example";
    }
    if (condition === "not-sent") {
      result.outcome = "not_sent";
    }
    if (condition === "suppressed" || condition === "unknown" || condition === "queued") {
      state = condition;
    }
    if (condition === "session-reset") {
      await replaceSessionEntry(scope, {
        sessionId: "replacement",
        updatedAt: 2,
        label: "new owner",
      });
    }
    if (condition === "intent-replaced") {
      await patchSessionEntryCore(scope, (entry) => ({
        pendingFinalDelivery: { ...entry.pendingFinalDelivery!, intentId: "replacement-intent" },
      }));
    }
    const before = loadSessionEntry(scope);
    const outcome = await settlePendingFinalDelivery(completion, state, undefined, {
      identifiedResult: result,
    });
    await closeOpenClawAgentDatabasesAsync(tmpDir);
    const after = loadSessionEntry(scope);
    expect(getRestartRecoveryTerminalDeliveryEvidence(after, sourceRunId)).toBeUndefined();
    if (condition === "session-reset" || condition === "intent-replaced") {
      expect(outcome.state).toBe("stale");
      expect(after).toEqual(before);
    } else {
      expect(after?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state },
      ]);
      expect(resolveRequesterRecoveryDelivery(after, sourceRunId)).toMatchObject({
        kind: "delivery",
        delivery: { delivered: false },
      });
    }
    if (condition === "unknown") {
      expect(after?.pendingDeliveryNotice).toMatchObject({ state: "owed", context });
    }
  });

  it.each(["channel", "account", "thread", "source"] as const)(
    "does not bind a final captured for another %s",
    async (mismatch) => {
      const captureContext = {
        channel: mismatch === "channel" ? "discord" : "matrix",
        to: "!original:example",
        ...(mismatch === "account" ? { accountId: "another-account" } : {}),
        ...(mismatch === "thread" ? { threadId: "another-thread" } : {}),
      };
      const { scope, sourceRunId, completion } = await prepareFinal({
        captureContext,
        replaceSourceBeforeCapture: mismatch === "source",
      });
      expect(loadSessionEntry(scope)?.pendingFinalDelivery?.sourceRunId).toBeUndefined();
      if (mismatch === "source") {
        expect(completion).toBeUndefined();
        expect(loadSessionEntry(scope)?.pendingFinalDelivery).toBeUndefined();
        expect(loadSessionEntry(scope)?.restartRecoveryDeliverySourceRunId).toBe("later-source");
        return;
      }
      if (!completion) {
        throw new Error("Expected final custody");
      }
      await settlePendingFinalDelivery(completion, "delivered", undefined, {
        identifiedResult: { channel: captureContext.channel, messageId: "sent-elsewhere" },
      });
      await closeOpenClawAgentDatabasesAsync(tmpDir);
      const after = loadSessionEntry(scope);
      expect(getRestartRecoveryTerminalDeliveryEvidence(after, sourceRunId)).toBeUndefined();
      expect(getRestartRecoveryTerminalDeliveryEvidence(after, "later-source")).toBeUndefined();
    },
  );

  it("waits for every final payload before retaining a receipt and preserves a newer claim", async () => {
    const { scope, sourceRunId, context, completion } = await prepareFinal();
    if (!completion) {
      throw new Error("Expected final custody");
    }
    await patchSessionEntryCore(scope, (entry) => ({
      pendingFinalDelivery: {
        ...entry.pendingFinalDelivery!,
        deliveries: [
          ...entry.pendingFinalDelivery!.deliveries!,
          { id: "second-payload", state: "prepared" },
        ],
      },
      restartRecoveryDeliverySourceRunId: "later-source",
      restartRecoveryDeliveryRunId: "later-run",
      restartRecoveryDeliveryContext: { channel: "discord", to: "later-room" },
    }));
    const result: OutboundDeliveryResult = {
      channel: "matrix",
      messageId: "first-provider-id",
      target: { kind: "room", id: context.to },
    };
    await settlePendingFinalDelivery(completion, "delivered", undefined, {
      identifiedResult: result,
    });
    expect(
      getRestartRecoveryTerminalDeliveryEvidence(loadSessionEntry(scope), sourceRunId),
    ).toBeUndefined();
    expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries?.[0]?.receipt).toMatchObject({
      platformMessageId: "first-provider-id",
    });
    await settlePendingFinalDelivery(
      { ...completion, deliveryId: "second-payload" },
      "delivered",
      undefined,
      { identifiedResult: { ...result, messageId: "second-provider-id" } },
    );
    expect(loadSessionEntry(scope)?.pendingFinalDelivery?.deliveries?.[1]?.receipt).toMatchObject({
      platformMessageId: "second-provider-id",
    });
    await clearPendingFinalDeliveryAfterSuccess(completion);
    await closeOpenClawAgentDatabasesAsync(tmpDir);
    const after = loadSessionEntry(scope);
    expect(getRestartRecoveryTerminalDeliveryEvidence(after, sourceRunId)).toMatchObject({
      durableFinalReceipt: { platformMessageId: "second-provider-id" },
    });
    expect(getRestartRecoveryTerminalDeliveryEvidence(after, "later-source")).toBeUndefined();
    expect(after).toMatchObject({
      restartRecoveryDeliveryRunId: "later-run",
      restartRecoveryDeliverySourceRunId: "later-source",
      restartRecoveryDeliveryContext: { channel: "discord", to: "later-room" },
    });
  });
});
