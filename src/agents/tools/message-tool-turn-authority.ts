import { isFencedProviderReadAction } from "../../channels/plugins/message-action-dispatch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { createAbortError } from "../../infra/abort-signal.js";

/** Keep discovery and execution bound to the same private turn identity. */
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
    captureCaller: (signal: AbortSignal | undefined, capture: () => (() => void) | undefined) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      const assertCurrent = capture();
      assertCurrent?.();
      return () => {
        assertCurrent?.();
        if (signal?.aborted) {
          throw createAbortError("Message action aborted");
        }
      };
    },
    beginInvocation: (action: string) => {
      const authorization = resolve();
      const isRead = isFencedProviderReadAction(action);
      const dashboardRead = authorization?.assertDashboardReadCurrent;
      const admitScheduled = authorization?.scheduled && params.admitScheduledInvocation;
      if (authorization?.scheduled && !admitScheduled) {
        throw new Error("Scheduled message invocation requires current tool policy admission.");
      }
      return {
        authorization,
        config: admitScheduled ? admitScheduled() : params.getConfig(),
        hasChannelTurnContext: Boolean(authorization && !authorization.scheduled && !dashboardRead),
        gatewayTurnCapability: dashboardRead && !isRead ? undefined : token,
        scheduledRead: isRead ? authorization?.scheduled : undefined,
        assertDashboardReadCurrent: isRead ? dashboardRead : undefined,
      };
    },
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
