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
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type {
  SessionActorDeliveryEvidence,
  SessionActorAuthority,
} from "../../config/sessions/session-actor-contract.js";
import {
  runSessionActorCommand,
  withSessionActor,
} from "../../config/sessions/session-actor-scope.js";
import type { PendingFinalDeliverySettlementInput } from "../../config/sessions/session-pending-final-settlement.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { isGatewayExternallySupervised } from "../gateway-supervision.js";
import { wrapSqliteWorkerError } from "../sqlite-worker-contract.js";
import {
  countPhysicalOutboundSends,
  type OutboundDeliveryBatch as DeliveryEvidenceBatch,
  type OutboundDeliveryResult,
} from "./deliver-types.js";
import {
  captureDeliveryPlacementEvidence,
  type DeliveryPlacementEvidence,
} from "./delivery-placement-evidence.js";
import type { DurableDeliveryCompletion } from "./delivery-queue-types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

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
    batch?: DeliveryEvidenceBatch;
    /** Delivery has settled; durable queue owners must retain their receipt until ACK. */
    clearAfterSettled?: { recoveryRunId?: string };
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
    ...(options.clearAfterSettled
      ? {
          cleanup: {
            sessionKey: completion.sessionKey,
            recoveryRunId: options.clearAfterSettled.recoveryRunId,
            now: Date.now(),
            preserveActivity: options.preserveActivity,
          },
        }
      : {}),
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
  const evidence = (entry: SessionEntry | undefined): SessionActorDeliveryEvidence => ({
    ...(claim ? { claim } : {}),
    result: resolvePendingFinalResultEvidence(options, entry?.pendingFinalDelivery?.context),
  });
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
  await withSessionActor(scope, { assertCurrent() {}, assertReadable() {} }, async (actor) => {
    let outcome;
    try {
      outcome = await runSessionActorCommand(actor, live, async (snapshot) => {
        // Only receipt evidence needs a captured route/version. State-only custody
        // changes validate atomically in deliverySettled without a preparatory read.
        const current = snapshot ?? (options.identifiedResult ? await actor.read(live) : undefined);
        return actor.deliverySettled(
          {
            commandId: randomUUID(),
            phaseId: randomUUID(),
            expected: current?.version,
            settlement,
            evidence: evidence(current?.entry),
          },
          live,
        );
      });
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
      throw wrapSqliteWorkerError(
        outcome.error.message,
        outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
        outcome.error,
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

/** Keep contradictions until every physical send has been checked against captured routing. */
function resolvePendingFinalResultEvidence(
  options: { identifiedResult?: OutboundDeliveryResult; batch?: DeliveryEvidenceBatch },
  context: DeliveryContext | undefined,
): SessionActorDeliveryEvidence["result"] {
  if (!context?.channel || !context.to || !options.identifiedResult) {
    return undefined;
  }
  const expectedTarget = normalizeTargetForProvider(context.channel, context.to);
  const matchesPlacement = (placement: DeliveryPlacementEvidence | undefined): boolean =>
    !placement ||
    (!placement.invalid &&
      placement.channels.every((channel) => channel === context.channel) &&
      placement.targets.every(
        (target) => normalizeTargetForProvider(context.channel!, target) === expectedTarget,
      ) &&
      placement.threads.every((thread) => thread === String(context.threadId ?? "").trim()));
  const matches = (result: OutboundDeliveryResult): boolean =>
    result.channel === context.channel &&
    result.outcome !== "not_sent" &&
    Boolean(readPlatformMessageId(result)) &&
    matchesPlacement(captureDeliveryPlacementEvidence(result));
  const batch = options.batch;
  const results = batch?.results ?? [options.identifiedResult];
  if (batch) {
    const indices = new Set(batch.payloadOutcomes.map((outcome) => outcome.index));
    if (
      batch.payloadCount < 1 ||
      batch.payloadOutcomes.length !== batch.payloadCount ||
      indices.size !== batch.payloadCount ||
      batch.payloadOutcomes.some(
        (outcome) =>
          outcome.index < 0 ||
          outcome.index >= batch.payloadCount ||
          outcome.status !== "sent" ||
          outcome.incompleteReason !== undefined ||
          !matchesPlacement(outcome.reportedPlacement) ||
          !outcome.results.length ||
          !outcome.results.every(matches),
      )
    ) {
      return undefined;
    }
  }
  if (!results.length || !results.every(matches) || !matches(options.identifiedResult)) {
    return undefined;
  }
  return {
    channel: context.channel,
    platformMessageId: readPlatformMessageId(options.identifiedResult),
    resultCount: countPhysicalOutboundSends(results),
    verifiedContext: structuredClone(context),
  };
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
  batch?: DeliveryEvidenceBatch,
): Promise<DurableDeliveryCompletionResult> {
  return settleDurableDelivery(completion, { result, batch }, stateDir, stateContext, target);
}

type DurableDeliveryTerminalEvidence =
  | { result: OutboundDeliveryResult; batch?: DeliveryEvidenceBatch }
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
        ...("result" in evidence
          ? { identifiedResult: evidence.result, batch: evidence.batch }
          : {}),
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
