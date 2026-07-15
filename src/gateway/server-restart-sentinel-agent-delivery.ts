import {
  collectAmbiguousAutomaticMediaUrls,
  collectAutomaticDeliveredMediaUrls,
  collectDeliveredMediaUrls,
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  hasCompleteAutomaticMediaDeliveryOutcomeEvidence,
  hasVisibleAgentPayload,
  type AgentDeliveryEvidence,
} from "../agents/embedded-agent-runner/delivery-evidence.js";
import { formatGeneratedMediaDeliveryRetryForPrompt } from "../agents/internal-events.js";
import { resolveDurableCompletionDeliveryMode } from "../auto-reply/reply/completion-delivery-policy.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  advanceSessionDeliveryAgentRun,
  deferSessionDelivery,
  failSessionDelivery,
  moveSessionDeliveryToFailed,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  type QueuedSessionDelivery,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const AGENT_DELIVERY_OWNERSHIP_RETRY_MS = 1_000;

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

async function deadLetterSessionDelivery(id: string, reason: string): Promise<never> {
  await moveSessionDeliveryToFailed(id);
  throw new SessionDeliveryDeadLetteredError(reason);
}

function hasQueuedVisiblePayload(payload: unknown): boolean {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const visible = (payload as { visible?: unknown }).visible;
    if (typeof visible === "boolean") {
      return visible;
    }
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    },
  );
}

function hasQueuedVisibleAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">): boolean {
  return Array.isArray(result.payloads) && result.payloads.some(hasQueuedVisiblePayload);
}

function hasUnexpectedRecoverySideEffects(result: AgentDeliveryEvidence): boolean {
  return (
    result.restartUnsafeSideEffectsDetected === true ||
    result.messagingToolAggregateEvidenceUnaccounted === true ||
    result.messagingToolSentTargetsTruncated === true ||
    result.didSendDeterministicApprovalPrompt === true ||
    hasCommittedOutboundDeliveryEvidence(result)
  );
}

function resolveQueuedAgentRunId(entry: QueuedAgentTurnSessionDelivery) {
  const base = entry.idempotencyKey ?? entry.messageId;
  return entry.agentRunAttempt ? `${base}:attempt:${entry.agentRunAttempt}` : base;
}

function collectVisiblePayloadMediaUrls(result: AgentDeliveryEvidence): string[] {
  const urls = new Set<string>();
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  for (const payload of payloads) {
    if (!hasQueuedVisiblePayload(payload)) {
      continue;
    }
    for (const url of collectDeliveredMediaUrls({ payloads: [payload] })) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function collectQueuedDeliveredMediaUrls(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): string[] {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return collectVisiblePayloadMediaUrls(params.result);
  }
  return collectAutomaticDeliveredMediaUrls(params.result);
}

function hasAutomaticVisibleSendEvidence(result: AgentDeliveryEvidence): boolean {
  if (result.deliveryStatus?.status === "sent" || result.deliveryStatus?.status === "suppressed") {
    return hasQueuedVisibleAgentPayload(result);
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = Array.isArray(result.deliveryStatus?.payloadOutcomes)
    ? result.deliveryStatus.payloadOutcomes
    : [];
  return outcomes.some((outcome) => {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return false;
    }
    const record = outcome as Record<string, unknown>;
    if (
      record.status !== "sent" &&
      record.status !== "suppressed" &&
      record.sentBeforeError !== true
    ) {
      return false;
    }
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    return index !== undefined && hasQueuedVisiblePayload(payloads[index]);
  });
}

function hasQueuedVisibleReplyEvidence(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): boolean {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return hasQueuedVisibleAgentPayload(params.result);
  }
  return hasAutomaticVisibleSendEvidence(params.result);
}

async function evaluateQueuedGeneratedMediaAgentResult(params: {
  entry: QueuedAgentTurnSessionDelivery;
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}) {
  if (hasUnexpectedRecoverySideEffects(params.result)) {
    log.warn("queued generated-media recovery reported an unexpected committed side effect", {
      queueId: params.entry.id,
    });
    await deadLetterSessionDelivery(
      params.entry.id,
      "queued generated-media delivery dead-lettered after an unexpected committed side effect",
    );
  }
  const expectedMediaUrls = params.entry.expectedMediaUrls ?? [];
  const deliveredMediaUrls = new Set(collectQueuedDeliveredMediaUrls(params));
  const missingMediaUrls = expectedMediaUrls.filter((url) => !deliveredMediaUrls.has(url));
  const ambiguousMediaUrls = new Set(collectAmbiguousAutomaticMediaUrls(params.result));
  const deliveryFailure = getAgentCommandDeliveryFailure(params.result);
  const replySatisfied =
    expectedMediaUrls.length > 0
      ? missingMediaUrls.length === 0
      : hasQueuedVisibleReplyEvidence(params);
  const evidenceTruncated = params.result.payloadsTruncated === true;
  if (evidenceTruncated && !replySatisfied) {
    log.warn("queued generated-media delivery has truncated delivery evidence", {
      queueId: params.entry.id,
    });
    await deadLetterSessionDelivery(
      params.entry.id,
      "queued generated-media delivery dead-lettered after truncated evidence",
    );
  }
  if (expectedMediaUrls.length > 0 && missingMediaUrls.length === 0) {
    return;
  }
  const rearmAgentRun = async (
    reason: string,
    updates?: {
      expectedMediaUrls?: string[];
      message?: string;
      suppressTextDelivery?: boolean;
    },
  ): Promise<never> => {
    const currentAgentRunAttempt = params.entry.agentRunAttempt ?? 0;
    const currentAttemptAlreadyCharged =
      params.entry.lastChargedAgentRunAttempt === currentAgentRunAttempt;
    // Charge the terminal attempt before advancing its identity. Recovery may
    // revisit the same durable evidence, but must never charge that attempt twice.
    if (!currentAttemptAlreadyCharged) {
      await failSessionDelivery(params.entry.id, reason);
    }
    try {
      if (updates) {
        await advanceSessionDeliveryAgentRun(params.entry.id, updates);
      } else {
        await advanceSessionDeliveryAgentRun(params.entry.id);
      }
      await deferSessionDelivery(params.entry.id, AGENT_DELIVERY_OWNERSHIP_RETRY_MS);
    } catch (error) {
      log.warn("queued generated-media terminal attempt state transition remains pending", {
        queueId: params.entry.id,
        error: String(error),
      });
      throw new SessionDeliveryRetryChargedError(
        `${reason}; queue state transition failed after retry charge`,
      );
    }
    throw new SessionDeliveryDeferredError(reason);
  };
  if (deliveryFailure && expectedMediaUrls.length > 0) {
    const incompletePartialFailureEvidence =
      params.result.deliveryStatus?.status === "partial_failed" &&
      !hasCompleteAutomaticMediaDeliveryOutcomeEvidence(params.result, missingMediaUrls);
    if (
      incompletePartialFailureEvidence ||
      missingMediaUrls.some((url) => ambiguousMediaUrls.has(url))
    ) {
      log.warn("queued generated-media delivery has ambiguous attachment side effects", {
        queueId: params.entry.id,
        error: deliveryFailure,
      });
      await deadLetterSessionDelivery(
        params.entry.id,
        "queued generated-media delivery dead-lettered after ambiguous side effects",
      );
    }
  } else if (deliveryFailure) {
    if (hasQueuedVisibleReplyEvidence(params)) {
      log.warn("queued generated-media notice may already be visible; refusing duplicate replay", {
        queueId: params.entry.id,
        error: deliveryFailure,
      });
      await deadLetterSessionDelivery(
        params.entry.id,
        "queued generated-media notice dead-lettered after a visible partial delivery",
      );
    }
    await rearmAgentRun(deliveryFailure);
  }
  if (missingMediaUrls.length > 0) {
    const retryMessage = formatGeneratedMediaDeliveryRetryForPrompt(missingMediaUrls);
    const qualifier =
      missingMediaUrls.length < expectedMediaUrls.length ? "partially missed" : "missed";
    const reason = `queued generated-media agent turn ${qualifier} expected media: ${missingMediaUrls.join(", ")}`;
    await rearmAgentRun(reason, {
      expectedMediaUrls: missingMediaUrls,
      ...(missingMediaUrls.length < expectedMediaUrls.length ||
      hasQueuedVisibleReplyEvidence(params)
        ? { suppressTextDelivery: true }
        : {}),
      ...(retryMessage ? { message: retryMessage } : {}),
    });
  }
  if (expectedMediaUrls.length === 0 && !hasQueuedVisibleReplyEvidence(params)) {
    await rearmAgentRun("queued generated-media agent turn completed without a visible reply");
  }
}

/** Runs durable generated-media handoffs through the normal owning-session agent loop. */
export async function deliverQueuedGeneratedMediaAgentTurn(params: {
  canonicalKey: string;
  entry: QueuedSessionDelivery;
  sessionEntry?: SessionEntry;
}): Promise<boolean> {
  const route = params.entry.route;
  if (
    params.entry.kind !== "agentTurn" ||
    !route ||
    params.entry.inputProvenance?.kind !== "inter_session" ||
    !params.entry.sourceReplyDeliveryMode
  ) {
    return false;
  }

  const queuedRunId = resolveQueuedAgentRunId(params.entry);
  const deliveryMode = resolveDurableCompletionDeliveryMode(params.entry.sourceReplyDeliveryMode);
  if (deliveryMode === "host_owned" && route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return await deadLetterSessionDelivery(
      params.entry.id,
      "queued host-owned generated-media delivery requires an external route",
    );
  }
  // `host_owned` is the explicit-send equivalent of message-tool-only policy.
  // The queue owner fixes route/media and disables the model-facing message tool,
  // so only this one system completion can use the normal final-delivery transport.
  const sourceReplyDeliveryMode = "automatic" as const;
  const cronLifecycleRevision = params.sessionEntry?.cronRunContinuation?.lifecycleRevision?.trim();
  const cronSessionId = cronLifecycleRevision ? params.sessionEntry?.sessionId?.trim() : undefined;
  const response = await dispatchGatewayMethodInProcess(
    "agent",
    {
      sessionKey: params.canonicalKey,
      message: params.entry.message,
      deliver:
        sourceReplyDeliveryMode === "automatic" && route.channel !== INTERNAL_MESSAGE_CHANNEL,
      bestEffortDeliver: false,
      channel: route.channel,
      accountId: route.accountId,
      to: route.to,
      threadId: route.threadId,
      ...(cronSessionId ? { sessionId: cronSessionId } : {}),
      inputProvenance: params.entry.inputProvenance,
      sourceReplyDeliveryMode,
      disableMessageTool: true,
      forceRestartSafeTools: true,
      idempotencyKey: queuedRunId,
    },
    {
      ...(cronSessionId ? { allowSyntheticCronRunContinuation: true } : {}),
      expectFinal: true,
      forceSyntheticClient: true,
      internalDeliveryMediaUrls: params.entry.expectedMediaUrls ?? [],
      ...(params.entry.suppressTextDelivery === true ? { internalDeliverySuppressText: true } : {}),
    },
  );
  const result = getGatewayAgentResult(response);
  if (!result) {
    const responseStatus =
      response && typeof response === "object"
        ? (response as { status?: unknown }).status
        : undefined;
    const latestEntry = loadSessionEntry(params.entry.sessionKey).entry;
    if (
      responseStatus === "accepted" ||
      responseStatus === "in_flight" ||
      (latestEntry?.restartRecoveryDeliverySourceRunId === queuedRunId &&
        latestEntry.restartRecoveryDeliveryRunId)
    ) {
      await deferSessionDelivery(params.entry.id, AGENT_DELIVERY_OWNERSHIP_RETRY_MS);
      throw new SessionDeliveryDeferredError(
        "queued generated-media agent turn is still owned by agent recovery",
      );
    }
    if (hasRestartRecoveryTerminalRun(latestEntry, queuedRunId)) {
      const terminalEvidence = getRestartRecoveryTerminalDeliveryEvidence(latestEntry, queuedRunId);
      if (terminalEvidence) {
        await evaluateQueuedGeneratedMediaAgentResult({
          entry: params.entry,
          result: terminalEvidence,
          route,
        });
        return true;
      }
      log.warn(
        "queued generated-media agent turn ended without durable delivery evidence; failing closed",
        { queueId: params.entry.id, runId: queuedRunId },
      );
      await deadLetterSessionDelivery(
        params.entry.id,
        "queued generated-media agent turn dead-lettered without durable terminal evidence",
      );
    }
    throw new Error("queued generated-media agent turn returned no delivery result");
  }
  await evaluateQueuedGeneratedMediaAgentResult({
    entry: params.entry,
    result,
    route,
  });
  return true;
}
