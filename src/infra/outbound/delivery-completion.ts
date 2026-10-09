import { getOwedHarnessCompletionTask } from "../../agents/agent-harness-completion-recovery.js";
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
import type {
  ConversationRegistryScope,
  PreparedConversationRegistryScope,
} from "../../config/sessions/conversation-registry.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  projectPendingFinalDeliverySettlement,
  type PendingFinalDeliverySettlementInput,
} from "../../config/sessions/session-pending-final-settlement.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { isGatewayExternallySupervised } from "../gateway-supervision.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { DurableDeliveryCompletion } from "./delivery-queue-types.js";

/** In-process locator captured before delivery preparation; never queue payload data. */
export type ConversationDeliveryTarget = Pick<
  PreparedConversationRegistryScope,
  "agentId" | "databaseAgentId" | "storePath"
> &
  DeliveryQueueStateContext;

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
  update: (scope: ConversationRegistryScope) => Promise<ConversationDeliveryRecord>,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  let record: ConversationDeliveryRecord;
  try {
    record = await update(
      resolveConversationDeliveryScope(completion, stateDir, stateContext, target),
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
  const scope = {
    agentId: completion.agentId,
    sessionKey: completion.sessionKey,
    storePath: completion.storePath,
    env: resolveDeliveryQueueStateEnv(options.stateDir, options.stateContext),
  };
  const settlement: PendingFinalDeliverySettlementInput = {
    sessionId: completion.sessionId,
    intentId: completion.intentId,
    deliveryId: completion.deliveryId,
    state,
    expectedStates: expectedStates?.slice(),
  };
  const patchOptions = {
    skipMaintenance: true,
    takeCacheOwnership: true,
    preserveActivity: options.preserveActivity,
    workerGuard: {},
  };
  const authority = completion.sessionWriterDeliveryAuthority;
  const claim = authority?.harnessCompletion;
  if (!claim) {
    if (
      completion.agentId !== undefined &&
      authority?.agentId !== undefined &&
      normalizeAgentId(authority.agentId) !== normalizeAgentId(completion.agentId)
    ) {
      return { state: "stale" };
    }
    let committed = false;
    const entry = await applySessionEntryOperation(
      scope,
      { kind: "pending-final-settle", settlement },
      {
        ...patchOptions,
        onCommitted(current) {
          const delivery = current.pendingFinalDelivery?.deliveries?.find(
            ({ id }) => id === settlement.deliveryId,
          );
          if (!delivery) {
            throw new Error("Pending final settlement omitted its committed delivery");
          }
          committed = true;
          settled = delivery.state;
          wakeRecovery = settled !== "queued" && current.abortedLastRun === true;
        },
      },
    );
    if (!committed && entry) {
      // A null reduction still distinguishes a terminal replay from refused expected states.
      settled = projectPendingFinalDeliverySettlement(entry, settlement).state;
    }
  } else {
    await patchSessionEntryCore(
      scope,
      (entry) => {
        // The host claim may invoke live source authority; retain its exact selection ordering.
        if (
          entry.sessionId !== completion.sessionId ||
          entry.pendingFinalDelivery?.intentId !== completion.intentId ||
          !entry.pendingFinalDelivery.deliveries?.some(({ id }) => id === completion.deliveryId)
        ) {
          return null;
        }
        if (
          completion.agentId !== undefined &&
          ((authority?.agentId !== undefined &&
            normalizeAgentId(authority.agentId) !== normalizeAgentId(completion.agentId)) ||
            normalizeAgentId(claim.requesterAgentId) !== normalizeAgentId(completion.agentId))
        ) {
          return null;
        }
        if (
          !authority ||
          authority.sessionKey !== completion.sessionKey ||
          (authority.storePath !== undefined && authority.storePath !== completion.storePath) ||
          claim.requesterSessionKey !== completion.sessionKey ||
          claim.sessionId !== completion.sessionId ||
          authority.expectedSessionId !== completion.sessionId ||
          (authority.agentId !== undefined && authority.agentId !== claim.requesterAgentId) ||
          (authority.expectedLifecycleRevision !== undefined &&
            authority.expectedLifecycleRevision !== entry.lifecycleRevision) ||
          (authority.expectedWriterRunId !== undefined &&
            authority.expectedWriterRunId !== entry.activeWriterRunId) ||
          !getOwedHarnessCompletionTask(claim, entry)
        ) {
          return null;
        }
        const result = options.identifiedResult;
        const projected = projectPendingFinalDeliverySettlement(entry, settlement, {
          claim,
          result: result
            ? {
                channel: result.channel,
                target: result.target,
                platformMessageId: readPlatformMessageId(result),
              }
            : undefined,
        });
        settled = projected.state;
        wakeRecovery = projected.wakeRecovery;
        return projected.patch;
      },
      patchOptions,
    );
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
  return settleDurableDelivery(completion, { result }, stateDir, stateContext, target);
}

type DurableDeliveryTerminalEvidence =
  | { result: OutboundDeliveryResult }
  | { rejectionError: string }
  | { platformSendStarted: boolean };

/** Settles the completion owner from the final evidence held by its lifecycle owner. */
export async function settleDurableDelivery(
  completion: DurableDeliveryCompletion,
  evidence: DurableDeliveryTerminalEvidence,
  stateDir?: string,
  stateContext?: DeliveryQueueStateContext,
  target?: ConversationDeliveryTarget,
): Promise<DurableDeliveryCompletionResult> {
  // Proven no-send rejections suppress a pending final without owing an
  // uncertainty notice; conversation delivery retains the explicit rejection.
  const state =
    "result" in evidence
      ? "delivered"
      : "platformSendStarted" in evidence && evidence.platformSendStarted
        ? "unknown"
        : "suppressed";
  return completion.kind === "pending-final"
    ? await settlePendingFinalDelivery(completion, state, undefined, {
        stateDir,
        stateContext,
        ...("result" in evidence ? { identifiedResult: evidence.result } : {}),
      })
    : conversationResult(
        completion,
        (scope) => {
          if ("result" in evidence) {
            return markConversationDeliverySent(
              scope,
              completion.operationId,
              readPlatformMessageId(evidence.result),
            );
          }
          if ("rejectionError" in evidence) {
            return markConversationDeliveryRejected(
              scope,
              completion.operationId,
              evidence.rejectionError,
            );
          }
          return evidence.platformSendStarted
            ? markConversationDeliveryUnknown(scope, completion.operationId)
            : markConversationDeliverySuppressed(scope, completion.operationId);
        },
        stateDir,
        stateContext,
        target,
      );
}
