import { randomUUID } from "node:crypto";
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
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import {
  runSessionActorCommand,
  withSessionActor,
} from "../../config/sessions/session-actor-scope.js";
import {
  projectPendingFinalDeliverySettlement,
  type PendingFinalDeliverySettlementInput,
} from "../../config/sessions/session-pending-final-settlement.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
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
import { SqliteWorkerError } from "../sqlite-worker-contract.js";
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
  const authority = completion.sessionWriterDeliveryAuthority;
  const claim = authority?.harnessCompletion;
  if (
    completion.agentId !== undefined &&
    authority?.agentId !== undefined &&
    normalizeAgentId(authority.agentId) !== normalizeAgentId(completion.agentId)
  ) {
    return { state: "stale" };
  }
  let refused = false;
  let preimage: SessionEntry | undefined;
  const hasCurrentClaim = (entry: SessionEntry | undefined, previous = entry) =>
    !claim ||
    Boolean(
      entry &&
      previous &&
      entry.sessionId === completion.sessionId &&
      entry.pendingFinalDelivery?.intentId === completion.intentId &&
      entry.pendingFinalDelivery.deliveries?.some(({ id }) => id === completion.deliveryId) &&
      authority &&
      authority.sessionKey === completion.sessionKey &&
      (authority.storePath === undefined || authority.storePath === completion.storePath) &&
      claim.requesterSessionKey === completion.sessionKey &&
      claim.sessionId === completion.sessionId &&
      authority.expectedSessionId === completion.sessionId &&
      (authority.agentId === undefined || authority.agentId === claim.requesterAgentId) &&
      (completion.agentId === undefined ||
        normalizeAgentId(claim.requesterAgentId) === normalizeAgentId(completion.agentId)) &&
      (authority.expectedLifecycleRevision === undefined ||
        authority.expectedLifecycleRevision === entry.lifecycleRevision) &&
      (authority.expectedWriterRunId === undefined ||
        authority.expectedWriterRunId === entry.activeWriterRunId) &&
      getOwedHarnessCompletionTask(claim, previous),
    );
  const evidence = claim
    ? {
        claim,
        result: options.identifiedResult
          ? {
              channel: options.identifiedResult.channel,
              target: options.identifiedResult.target,
              platformMessageId: readPlatformMessageId(options.identifiedResult),
            }
          : undefined,
      }
    : undefined;
  const live: SessionActorAuthority = {
    assertCurrent() {},
    authorize(stage, facts) {
      if (stage === "transaction" || !preimage) {
        preimage = facts.entry;
      }
      if (!hasCurrentClaim(facts.entry, preimage)) {
        refused = true;
        throw new Error("Pending final delivery authority was revoked");
      }
    },
  };
  let actorOwned = false;
  await withSessionActor(scope, { assertCurrent() {}, assertReadable() {} }, async (actor) => {
    actorOwned = true;
    let outcome;
    try {
      outcome = await runSessionActorCommand(actor, live, (snapshot) =>
        actor.deliverySettled(
          {
            commandId: randomUUID(),
            phaseId: randomUUID(),
            expected: snapshot?.version,
            settlement,
            ...(evidence ? { evidence } : {}),
          },
          live,
        ),
      );
    } catch (error) {
      // No command was accepted if its read's live authorization refused.
      if (refused) {
        return;
      }
      throw error;
    }
    if (outcome.kind !== "committed") {
      if (outcome.kind === "rolled-back" && (refused || outcome.reason === "stale-state")) {
        return;
      }
      throw new SqliteWorkerError(
        outcome.error.message,
        outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
      );
    }
    if (!("state" in outcome.value)) {
      throw new Error("Pending final delivery returned another settlement");
    }
    settled = outcome.value.state;
    wakeRecovery = outcome.value.wakeRecovery;
    if (outcome.failure) {
      throw new Error(outcome.failure.message);
    }
  });
  if (!actorOwned) {
    // Native incognito retains its existing patch owner until its actor cutover.
    const patchOptions = {
      skipMaintenance: true,
      takeCacheOwnership: true,
      preserveActivity: options.preserveActivity,
      workerGuard: {},
    };
    await patchSessionEntryCore(
      scope,
      (entry) => {
        if (!hasCurrentClaim(entry)) {
          return null;
        }
        const projected = projectPendingFinalDeliverySettlement(entry, settlement, evidence);
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
