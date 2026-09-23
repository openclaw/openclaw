import type { SessionWriterDeliveryAuthority } from "../../auto-reply/reply-payload.js";
import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  ConversationDeliveryMissingError,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../../config/sessions/conversation-delivery-store.js";
import {
  runConversationDatabaseWrite,
  type ConversationRegistryScope,
  type PreparedConversationRegistryScope,
} from "../../config/sessions/conversation-registry.js";
import { mergeRestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "../../config/sessions/restart-recovery-types.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { getOwedHarnessCompletionTask } from "../../tasks/agent-harness-completion-recovery.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { isGatewayExternallySupervised } from "../gateway-supervision.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

/** In-process locator captured before delivery preparation; never queue payload data. */
export type ConversationDeliveryTarget = Pick<
  PreparedConversationRegistryScope,
  "agentId" | "databaseAgentId" | "storePath"
> & {
  stateDir: string;
  workerContext: OpenClawStateWorkerContext;
  supervisorMode?: "external";
};

export function captureConversationDeliveryTarget(
  scope: PreparedConversationRegistryScope,
): ConversationDeliveryTarget {
  return {
    workerContext: captureOpenClawStateWorkerContext({ env: scope.env }),
    agentId: scope.agentId,
    databaseAgentId: scope.databaseAgentId,
    storePath: scope.storePath,
    stateDir: resolveStateDir(scope.env),
    ...(isGatewayExternallySupervised(scope.env) ? { supervisorMode: "external" as const } : {}),
  };
}

/** Serializable owner callback for a durable queue entry. */
export type DurableDeliveryCompletion =
  | {
      kind: "conversation";
      agentId: string;
      operationId: string;
      storePath?: string;
      /** Present on Gateway-owned conversation intents created with route authorization. */
      routeFingerprint?: string;
    }
  | {
      kind: "pending-final";
      /** Older queue records retain the canonical locator's original owner selection. */
      agentId?: string;
      deliveryId: string;
      intentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
      sessionWriterDeliveryAuthority?: SessionWriterDeliveryAuthority;
    };

type DurableDeliveryCompletionResult = {
  state: "prepared" | "queued" | "delivered" | "suppressed" | "rejected" | "unknown" | "stale";
  platformMessageId?: string;
  rejectionError?: string;
};

export function resolveConversationDeliveryScope(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): ConversationRegistryScope {
  const scope = {
    agentId: completion.agentId,
    ...(completion.storePath ? { storePath: completion.storePath } : {}),
    env: resolveDeliveryQueueStateEnv(stateDir, target ?? stateContext),
  };
  if (!target) {
    return scope;
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  if (
    normalizeAgentId(scope.agentId) !== normalizeAgentId(target.agentId) ||
    options.agentId !== target.databaseAgentId ||
    !isSameOpenClawAgentDatabasePath(resolveOpenClawAgentSqlitePath(options), target.storePath)
  ) {
    throw new Error("Conversation delivery target does not match durable custody");
  }
  return { ...scope, storePath: target.storePath, databaseAgentId: target.databaseAgentId };
}

async function conversationResult(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
  update: (scope: PreparedConversationRegistryScope) => ConversationDeliveryRecord,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  let record: ConversationDeliveryRecord;
  try {
    record = await runConversationDatabaseWrite(
      resolveConversationDeliveryScope(completion, stateDir, stateContext, target),
      update,
    );
  } catch (error) {
    // Full session deletion can retire the owner before its shared queue settles.
    if (error instanceof ConversationDeliveryMissingError) {
      return { state: "stale" };
    }
    throw error;
  }
  const delivered = record.status === "sent" || record.status === "replied";
  return {
    state: delivered
      ? "delivered"
      : record.status === "suppressed" ||
          record.status === "rejected" ||
          record.status === "unknown"
        ? record.status
        : "queued",
    ...(delivered && (record.platformMessageId || record.preparedMessageId)
      ? { platformMessageId: record.platformMessageId ?? record.preparedMessageId }
      : {}),
    ...(record.status === "rejected" && record.rejectionError
      ? { rejectionError: record.rejectionError }
      : {}),
  };
}

export async function settlePendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: Exclude<DurableDeliveryCompletionResult["state"], "rejected" | "stale">,
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[],
  options: {
    stateDir?: string;
    preserveActivity?: boolean;
    stateContext?: DeliveryQueueStateContext;
    identifiedResult?: OutboundDeliveryResult;
  } = {},
): Promise<DurableDeliveryCompletionResult> {
  let settled: DurableDeliveryCompletionResult["state"] = "stale";
  let wakeRecovery = false;
  let deliveredHarnessClaim: HarnessCompletionRecovery | undefined;
  await patchSessionEntryCore(
    {
      agentId: completion.agentId,
      sessionKey: completion.sessionKey,
      storePath: completion.storePath,
      env: resolveDeliveryQueueStateEnv(options.stateDir, options.stateContext),
    },
    (entry) => {
      const internalEntry: InternalSessionEntry = entry;
      if (
        internalEntry.sessionId !== completion.sessionId ||
        internalEntry.pendingFinalDelivery?.intentId !== completion.intentId
      ) {
        return null;
      }
      const deliveries = internalEntry.pendingFinalDelivery.deliveries;
      const index = deliveries?.findIndex(({ id }) => id === completion.deliveryId) ?? -1;
      if (!deliveries || index < 0) {
        return null;
      }
      const authority = completion.sessionWriterDeliveryAuthority;
      const claim = authority?.harnessCompletion;
      if (
        completion.agentId !== undefined &&
        ((authority?.agentId !== undefined &&
          normalizeAgentId(authority.agentId) !== normalizeAgentId(completion.agentId)) ||
          (claim &&
            normalizeAgentId(claim.requesterAgentId) !== normalizeAgentId(completion.agentId)))
      ) {
        return null;
      }
      if (
        claim &&
        (!authority ||
          authority.sessionKey !== completion.sessionKey ||
          (authority.storePath !== undefined && authority.storePath !== completion.storePath) ||
          claim.requesterSessionKey !== completion.sessionKey ||
          claim.sessionId !== completion.sessionId ||
          authority.expectedSessionId !== completion.sessionId ||
          (authority.agentId !== undefined && authority.agentId !== claim.requesterAgentId) ||
          (authority.expectedLifecycleRevision !== undefined &&
            authority.expectedLifecycleRevision !== internalEntry.lifecycleRevision) ||
          (authority.expectedWriterRunId !== undefined &&
            authority.expectedWriterRunId !== internalEntry.activeWriterRunId) ||
          !getOwedHarnessCompletionTask(claim, internalEntry))
      ) {
        return null;
      }
      const current = deliveries[index]!.state;
      if (expectedStates && !expectedStates.some((expected) => expected === current)) {
        return null;
      }
      const terminal =
        current === "delivered" ||
        current === "suppressed" ||
        (current === "unknown" && state === "unknown");
      settled = terminal ? current : state;
      const pending = internalEntry.pendingFinalDelivery;
      const existingNotice = internalEntry.pendingDeliveryNotice;
      const owedNotice =
        settled === "unknown" &&
        (current === "queued" || current === "unknown") &&
        pending.context &&
        pending.intentId &&
        existingNotice?.intentId !== pending.intentId &&
        (!existingNotice || existingNotice.createdAt <= pending.createdAt)
          ? {
              pendingDeliveryNotice: {
                createdAt: pending.createdAt,
                context: pending.context,
                intentId: pending.intentId,
                state: "owed" as const,
              },
            }
          : undefined;
      const updatedDeliveries = deliveries.with(index, {
        id: completion.deliveryId,
        state: settled,
      });
      const result = options.identifiedResult;
      const platformMessageId = result ? readPlatformMessageId(result) : undefined;
      const context = pending.context;
      // Persist the receipt in the same transaction as pending-final completion,
      // before queue acknowledgement. A crash before the separate task-store
      // commit leaves this exact claim replayable by startup reconciliation.
      const terminalEvidence =
        claim &&
        result &&
        platformMessageId &&
        result.channel === context?.channel &&
        context?.to &&
        (!result.target || result.target.id === context.to) &&
        settled === "delivered" &&
        updatedDeliveries.every((delivery) => delivery.state === "delivered")
          ? mergeRestartRecoveryTerminalDeliveryEvidence(
              internalEntry.restartRecoveryTerminalDeliveryEvidence,
              [
                {
                  runId: claim.sourceRunId,
                  harnessCompletion: claim,
                  deliveryContext: context,
                  captured: true,
                  payloads: [{ visible: true }],
                  deliveryStatus: { status: "sent", resultCount: 1 },
                  durableFinalReceipt: {
                    intentId: completion.intentId,
                    deliveryId: completion.deliveryId,
                    platformMessageId,
                  },
                },
              ],
            )
          : undefined;
      deliveredHarnessClaim = terminalEvidence ? claim : undefined;
      const clearsNotice =
        existingNotice?.state !== "acknowledged" &&
        !updatedDeliveries.some((delivery) => delivery.state === "unknown") &&
        settled !== "queued" &&
        settled !== "unknown" &&
        existingNotice?.intentId === pending.intentId;
      // One resolved sibling cannot erase another's ambiguity. Acknowledgment
      // remains an intent-level fact so delayed settlement cannot owe it again.
      if (settled === current && !owedNotice && !clearsNotice && !terminalEvidence) {
        return null;
      }
      wakeRecovery =
        settled !== "queued" &&
        internalEntry.status === "running" &&
        internalEntry.abortedLastRun === true;
      return {
        ...(internalEntry.mainRestartRecovery
          ? {
              mainRestartRecovery: {
                ...internalEntry.mainRestartRecovery,
                revision: internalEntry.mainRestartRecovery.revision + 1,
              },
            }
          : {}),
        pendingFinalDelivery: {
          ...internalEntry.pendingFinalDelivery,
          deliveries: updatedDeliveries,
        },
        ...(clearsNotice ? { pendingDeliveryNotice: undefined } : owedNotice),
        ...(terminalEvidence ? { restartRecoveryTerminalDeliveryEvidence: terminalEvidence } : {}),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true, preserveActivity: options.preserveActivity },
  );
  if (deliveredHarnessClaim) {
    const claim = deliveredHarnessClaim;
    const { reconcileHarnessCompletionDelivery } =
      await import("../../agents/agent-harness-completion-delivery.js");
    reconcileHarnessCompletionDelivery({
      agentId: claim.requesterAgentId,
      sessionKey: completion.sessionKey,
      storePath: completion.storePath,
      sourceRunId: claim.sourceRunId,
      taskRunId: claim.taskRunId,
    });
  }
  if (wakeRecovery) {
    const { scheduleMainSessionRecoveryPendingTarget } =
      await import("../../agents/main-session-recovery/main-session-recovery-owner-release.js");
    scheduleMainSessionRecoveryPendingTarget({
      ...(completion.agentId !== undefined ? { agentId: completion.agentId } : {}),
      sessionId: completion.sessionId,
      sessionKey: completion.sessionKey,
      ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
      storePath: completion.storePath,
    });
  }
  return { state: settled };
}

function readPlatformMessageId(result: OutboundDeliveryResult): string | undefined {
  const receiptId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return receiptId ?? (result.messageId.trim() || undefined);
}

/** Records queue ownership before either the live sender or recovery crosses platform I/O. */
export async function markDurableDeliveryQueued(
  completion: DurableDeliveryCompletion,
  queueId: string,
  expectedPendingFinalState?: "prepared",
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? // The reply dispatcher may have claimed direct custody ("queued") before the
      // durable enqueue; both states still belong to this send attempt.
      await settlePendingFinalDelivery(
        completion,
        "queued",
        expectedPendingFinalState ? ["prepared", "queued"] : undefined,
        { stateDir, stateContext },
      )
    : conversationResult(
        completion,
        (scope) => markConversationDeliveryQueued(scope, completion.operationId, queueId),
        stateDir,
        stateContext,
        target,
      );
}

/** Finalizes owner state from identified platform evidence before queue acknowledgement. */
export async function completeDurableDelivery(
  completion: DurableDeliveryCompletion,
  result: OutboundDeliveryResult,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "delivered", undefined, {
        stateDir,
        stateContext,
        identifiedResult: result,
      })
    : conversationResult(
        completion,
        (scope) =>
          markConversationDeliverySent(
            scope,
            completion.operationId,
            readPlatformMessageId(result),
          ),
        stateDir,
        stateContext,
        target,
      );
}

/** Finalizes a policy-suppressed send before its durable intent is acknowledged. */
async function suppressDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "suppressed", undefined, {
        stateDir,
        stateContext,
      })
    : conversationResult(
        completion,
        (scope) => markConversationDeliverySuppressed(scope, completion.operationId),
        stateDir,
        stateContext,
        target,
      );
}

/** Finalizes a permanent provider rejection that provably preceded platform I/O. */
export async function rejectDurableDelivery(
  completion: DurableDeliveryCompletion,
  error: string,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  // Proven no-send: terminal suppression, not the unknown state that owes an
  // uncertainty notice for a send the provider asserts never began.
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "suppressed", undefined, {
        stateDir,
        stateContext,
      })
    : conversationResult(
        completion,
        (scope) => markConversationDeliveryRejected(scope, completion.operationId, error),
        stateDir,
        stateContext,
        target,
      );
}

/** Makes a dead-lettered durable send terminal without allowing a blind replay. */
export async function failDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, "unknown", undefined, { stateDir, stateContext })
    : conversationResult(
        completion,
        (scope) => markConversationDeliveryUnknown(scope, completion.operationId),
        stateDir,
        stateContext,
        target,
      );
}

type DurableDeliveryTerminalEvidence =
  | { result: OutboundDeliveryResult }
  | { platformSendStarted: boolean };

/** Settles the completion owner from the final evidence held by its lifecycle owner. */
export async function settleDurableDelivery(
  completion: DurableDeliveryCompletion,
  evidence: DurableDeliveryTerminalEvidence,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  return "result" in evidence
    ? completeDurableDelivery(completion, evidence.result, stateDir, stateContext, target)
    : evidence.platformSendStarted
      ? failDurableDelivery(completion, stateDir, stateContext, target)
      : suppressDurableDelivery(completion, stateDir, stateContext, target);
}
