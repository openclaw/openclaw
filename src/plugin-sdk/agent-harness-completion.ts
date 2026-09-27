/**
 * Runtime SDK helpers for host-authorized agent harness completion delivery.
 */
import {
  isAgentHarnessCompletionCustodyCurrent,
  runWithAgentHarnessCompletionCustody,
  type AgentHarnessCompletionCustody,
} from "../agents/agent-harness-completion-custody.js";
import { reconcileHarnessCompletionDelivery } from "../agents/agent-harness-completion-delivery.js";
import {
  assertAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
  type AgentHarnessCompletionScope,
} from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  type AgentInternalEventStatus,
} from "../agents/internal-event-contract.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../agents/internal-events.js";
import {
  deliverSubagentAnnouncement,
  isInternalAnnounceRequesterSession,
  loadRequesterSessionEntry,
} from "../agents/subagents/announce/subagent-announce-delivery.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "../agents/subagents/announce/subagent-announce-origin.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
export {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
} from "../agents/agent-harness-completion-custody.js";
export type { AgentHarnessCompletionCustody, AgentHarnessCompletionScope };

/** Completion states a harness task can report to its requester. */
export type AgentHarnessCompletionStatus = "succeeded" | "failed" | "cancelled";

/** Delivery result returned after routing a harness task completion announcement. */
export type AgentHarnessCompletionDelivery = Awaited<
  ReturnType<typeof deliverSubagentAnnouncement>
> & { recoveryPending?: true; recoveryBlocked?: true };

const AGENT_HARNESS_COMPLETION_SOURCE_TOOL = "agent_harness_completion";

/** Delivers a completed harness task result back to the requester or parent session. */
export async function deliverAgentHarnessCompletion(params: {
  scope: AgentHarnessCompletionScope;
  /** Retained during native admission and released by the assignment lifecycle owner. */
  completionCustody?: AgentHarnessCompletionCustody;
  childSessionKey: string;
  childSessionId: string;
  announceId: string;
  status: AgentHarnessCompletionStatus;
  statusLabel?: string;
  result: string;
  taskLabel?: string;
  announceType?: string;
  replyInstruction?: string;
  /** Current source owner may admit new delivery work; accepted work keeps its own lifecycle. */
  isSourceSessionAdmissionAllowed: () => boolean;
  signal?: AbortSignal;
  /** Plugin-owned historical locator can narrow admission, never grant ownership. */
  expectedRequester?: { sessionId: string; lifecycleRevision?: string };
}): Promise<AgentHarnessCompletionDelivery> {
  const scope = assertAgentHarnessCompletionScope(params.scope);
  const completionCustody = params.completionCustody;
  const signal = completionCustody
    ? AbortSignal.any([completionCustody.signal, ...(params.signal ? [params.signal] : [])])
    : params.signal;
  const requesterSessionKey = scope.requesterSessionKey;
  const childSessionKey = params.childSessionKey.trim();
  const childSessionId = params.childSessionId.trim();
  const taskLabel = params.taskLabel?.trim() || "Agent harness task";
  const announceType = params.announceType?.trim() || "Agent harness task";
  const statusLabel = params.statusLabel?.trim() || params.status;
  const eventStatus = mapHarnessCompletionStatus(params.status);
  const expectedRequester = params.expectedRequester;
  const requester = loadRequesterSessionEntry(requesterSessionKey, scope.requesterAgentId);
  const requesterSessionId = requester.entry?.sessionId;
  const requesterLifecycleRevision = requester.entry?.lifecycleRevision;
  const isRequesterCurrent = () => {
    if (completionCustody && !isAgentHarnessCompletionCustodyCurrent(completionCustody, scope)) {
      return false;
    }
    const current = loadRequesterSessionEntry(requesterSessionKey, scope.requesterAgentId).entry;
    return (
      Boolean(requesterSessionId) &&
      current?.sessionId === requesterSessionId &&
      current?.lifecycleRevision === requesterLifecycleRevision &&
      (!expectedRequester ||
        (current?.sessionId === expectedRequester.sessionId &&
          current?.lifecycleRevision === expectedRequester.lifecycleRevision))
    );
  };
  const isSourceSessionEffectsAllowed = () =>
    !signal?.aborted && isRequesterCurrent() && params.isSourceSessionAdmissionAllowed();
  const requesterIsSubagent = isInternalAnnounceRequesterSession(requesterSessionKey);
  let directOrigin = scope.requesterOrigin;
  if (!requesterIsSubagent) {
    directOrigin = resolveAnnounceOrigin(requester.entry, scope.requesterOrigin);
  }
  const completionDirectOrigin =
    requesterIsSubagent || !directOrigin
      ? directOrigin
      : await resolveSubagentCompletionOrigin({
          childSessionKey,
          requesterSessionKey,
          requesterOrigin: directOrigin,
          childRunId: childSessionKey,
          spawnMode: "run",
          expectsCompletionMessage: true,
        });
  const internalEvents: AgentInternalEvent[] = [
    {
      type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
      source: "subagent",
      childSessionKey,
      childSessionId,
      announceType,
      taskLabel,
      status: eventStatus,
      statusLabel,
      result: params.result,
      replyInstruction:
        params.replyInstruction?.trim() ||
        "Use the completed harness task result to continue or wrap up the parent task. If this is a channel session, send the visible response with the message tool instead of only writing a transcript final answer.",
    },
  ];
  const prompt = formatAgentInternalEventsForPrompt(internalEvents);
  const deliver = async (): Promise<AgentHarnessCompletionDelivery> => {
    if (!requesterSessionId || !isRequesterCurrent()) {
      return {
        delivered: false,
        path: "none",
        recoveryBlocked: true,
        error: "completion requester locator is missing or replaced",
      };
    }
    if (requester.agentId && requester.storePath) {
      const custody = reconcileHarnessCompletionDelivery({
        agentId: requester.agentId,
        storePath: requester.storePath,
        sessionKey: requester.canonicalKey,
        sourceRunId: buildAnnounceIdempotencyKey(params.announceId),
        taskRunId: childSessionKey,
      });
      if (custody === "delivered") {
        return { delivered: true, path: "direct" };
      }
      if (custody !== "unowned") {
        return {
          delivered: false,
          path: "none",
          ...(custody === "pending"
            ? { recoveryPending: true as const }
            : { recoveryBlocked: true as const }),
          error:
            custody === "pending"
              ? "completion is owned by requester recovery"
              : "completion recovery receipt or owner is unresolved",
        };
      }
    }
    return await withAgentHarnessCompletionAdmission(
      {
        scope,
        sourceSessionKey: childSessionKey,
        sourceRunId: buildAnnounceIdempotencyKey(params.announceId),
        requesterSessionId,
        requesterLifecycleRevision,
        isSourceCurrent: isSourceSessionEffectsAllowed,
      },
      () =>
        deliverSubagentAnnouncement({
          requesterSessionKey,
          requesterAgentId: scope.requesterAgentId,
          isSourceSessionEffectsAllowed,
          triggerMessage: prompt,
          steerMessage: prompt,
          internalEvents,
          requesterSessionOrigin: scope.requesterOrigin,
          completionDirectOrigin: completionDirectOrigin ?? directOrigin,
          directOrigin,
          sourceSessionKey: childSessionKey,
          sourceTool: AGENT_HARNESS_COMPLETION_SOURCE_TOOL,
          isSourceSessionAdmissionAllowed: isSourceSessionEffectsAllowed,
          targetRequesterSessionKey: requesterSessionKey,
          requesterIsSubagent,
          expectsCompletionMessage: true,
          bestEffortDeliver: true,
          directIdempotencyKey: buildAnnounceIdempotencyKey(params.announceId),
          signal,
        }),
    );
  };
  const resolveGatewayContext = getGatewayContextResolver(scope);
  const deliverInGateway = () =>
    resolveGatewayContext
      ? withPluginRuntimeGatewayContextResolver(resolveGatewayContext, deliver)
      : deliver();
  return completionCustody
    ? await runWithAgentHarnessCompletionCustody(completionCustody, scope, deliverInGateway)
    : await deliverInGateway();
}

function mapHarnessCompletionStatus(
  status: AgentHarnessCompletionStatus,
): AgentInternalEventStatus {
  if (status === "succeeded") {
    return "ok";
  }
  return "error";
}

/** Returns true when completion delivery reached a persistent direct or steered path. */
export function isDurableAgentHarnessCompletionDelivery(
  delivery: AgentHarnessCompletionDelivery,
): boolean {
  if (!delivery.delivered) {
    return false;
  }
  if (delivery.path === "steered") {
    return true;
  }
  if (delivery.path !== "direct") {
    return false;
  }
  const phases = Array.isArray(delivery.phases) ? delivery.phases : undefined;
  if (!phases) {
    return true;
  }
  return phases.some(
    (phase) => phase.phase === "direct-primary" && phase.delivered && phase.path === "direct",
  );
}
