import { isFencedProviderReadAction } from "../../channels/plugins/message-action-dispatch.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveCurrentPromptReaction,
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveReplyRunForCurrentSessionId } from "../../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

/** Resolve execution authority from the private turn identity. */
export function createMessageToolTurnAuthority(params: {
  token?: string;
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  getConfig: () => OpenClawConfig;
  admitScheduledInvocation?: () => OpenClawConfig;
}) {
  const { token, agentId, runId, sessionKey, sessionId } = params;
  const caller = getGatewayToolCallerIdentity();
  let capturedSourceReplyOperation =
    sessionId && runId ? findSessionControllerOperationByRunId(runId) : undefined;
  // Unscoped tools keep their construction-time owner, never a later replacement.
  if (!capturedSourceReplyOperation && sessionId && !caller?.operationalRunInstance) {
    const current = resolveReplyRunForCurrentSessionId(sessionId);
    capturedSourceReplyOperation = current.kind === "one" ? current.operation : undefined;
  }
  const lookup =
    agentId && sessionKey ? { token, agentId, runId, sessionKey, sessionId } : undefined;
  const resolve = () => lookup && resolveMessageActionTurnAuthorization(lookup);
  const scheduled = resolve()?.scheduled;
  const policy = scheduled?.policy;
  const origin = policy?.mode === "account" ? policy.ownerOrigin : undefined;
  const channels = origin?.kind === "external" ? [origin.channel] : [];
  const requester = scheduled?.channelRequester;
  if (
    policy?.mode === "account" &&
    requester?.channel === "discord" &&
    requester.accountId === policy.ownerAccountId &&
    !channels.includes(requester.channel)
  ) {
    channels.push(requester.channel);
  }
  return {
    captureCaller: (
      signal: AbortSignal | undefined,
      capture: () => SessionSourceAssertion | undefined,
    ) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      const assertCurrent = capture();
      assertCurrent?.();
      return composeSessionSourceAssertion([assertCurrent], (assertSource) => {
        assertSource();
        if (signal?.aborted) {
          throw createAbortError("Message action aborted");
        }
      });
    },
    beginInvocation: (action: string) => {
      // Native publication can follow tool construction; only the exact run may fill that gap.
      const sourceReplyOperation =
        capturedSourceReplyOperation ??
        (sessionId && runId ? findSessionControllerOperationByRunId(runId) : undefined);
      const authorization = resolve();
      const isRead = isFencedProviderReadAction(action);
      const dashboardRead = authorization?.assertDashboardReadCurrent;
      const currentPromptReaction = lookup && resolveCurrentPromptReaction(lookup);
      const admitScheduled = authorization?.scheduled && params.admitScheduledInvocation;
      if (authorization?.scheduled && !admitScheduled) {
        throw new Error("Scheduled message invocation requires current tool policy admission.");
      }
      return {
        authorization,
        currentPromptReaction,
        sourceReplyOperation,
        config: admitScheduled ? admitScheduled() : params.getConfig(),
        hasChannelTurnContext: Boolean(
          authorization &&
          !authorization.scheduled &&
          !authorization.deliveryAttempt &&
          !dashboardRead &&
          !currentPromptReaction,
        ),
        gatewayTurnCapability: dashboardRead && !isRead ? undefined : token,
        scheduledRead: isRead ? authorization?.scheduled : undefined,
        assertDashboardReadCurrent: isRead ? dashboardRead : undefined,
      };
    },
    isScheduledRun: Boolean(scheduled),
    scheduledAccountScope:
      policy?.mode === "account" && (origin?.kind === "local" || channels.length > 0)
        ? {
            accountId: policy.ownerAccountId,
            ...(origin?.kind === "local" ? {} : { channels }),
          }
        : undefined,
    assertCurrent: () => {
      if (token?.trim() && (!lookup || !resolveMessageActionTurnCapability(lookup))) {
        throw new Error("message action turn capability is no longer active");
      }
    },
  };
}
