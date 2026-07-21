import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookMessageContext,
  PluginHookOutboundDeliveryPolicyDestination,
  PluginHookOutboundDeliveryPolicyPath,
  PluginHookOutboundDeliveryPolicySource,
} from "../../plugins/hook-types.js";

type OutboundDeliveryPolicyDestination = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  path: PluginHookOutboundDeliveryPolicyPath;
};

export type OutboundDeliveryPolicySource = PluginHookOutboundDeliveryPolicySource;

type OutboundDeliveryPolicyKind = ReplyDispatchKind | "message_action";

export type OutboundDeliveryPolicyDecision =
  | {
      decision: "allow";
      payload: ReplyPayload;
      destination: PluginHookOutboundDeliveryPolicyDestination;
      reason?: string;
    }
  | {
      decision: "cancel";
      payload: ReplyPayload;
      destination: PluginHookOutboundDeliveryPolicyDestination;
      reason?: string;
    }
  | {
      decision: "reroute";
      payload: ReplyPayload;
      destination: PluginHookOutboundDeliveryPolicyDestination;
      reason?: string;
    };

export const MAX_OUTBOUND_DELIVERY_POLICY_REROUTES = 4;

/** Remove routing metadata that cannot safely cross a policy reroute. */
export function stripDestinationScopedReplyPayload(payload: ReplyPayload): ReplyPayload {
  const {
    replyToId: _replyToId,
    replyToTag: _replyToTag,
    replyToCurrent: _replyToCurrent,
    channelData: _channelData,
    ...portablePayload
  } = payload;
  return portablePayload;
}

function normalizeDestination(
  destination: OutboundDeliveryPolicyDestination,
): PluginHookOutboundDeliveryPolicyDestination {
  return {
    channel: destination.channel,
    to: destination.to,
    conversationId: destination.to,
    ...(destination.accountId ? { accountId: destination.accountId } : {}),
    ...(destination.threadId !== undefined && destination.threadId !== null
      ? { threadId: destination.threadId }
      : {}),
    path: destination.path,
  };
}

function buildHookContext(params: {
  destination: PluginHookOutboundDeliveryPolicyDestination;
  sessionKey?: string;
  runId?: string;
}): PluginHookMessageContext {
  return {
    channelId: params.destination.channel,
    accountId: params.destination.accountId,
    conversationId: params.destination.conversationId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

/** Runs outbound delivery policy hooks for one resolved payload destination. */
export async function runOutboundDeliveryPolicyHook(params: {
  payload: ReplyPayload;
  kind: OutboundDeliveryPolicyKind;
  action?: string;
  source?: OutboundDeliveryPolicySource;
  destination: OutboundDeliveryPolicyDestination;
  sessionKey?: string;
  runId?: string;
}): Promise<OutboundDeliveryPolicyDecision> {
  const destination = normalizeDestination(params.destination);
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("outbound_delivery_policy")) {
    return { decision: "allow", payload: params.payload, destination };
  }

  const result = await hookRunner.runOutboundDeliveryPolicy(
    {
      payload: params.payload,
      kind: params.kind,
      ...(params.action ? { action: params.action } : {}),
      ...(params.source ? { source: params.source } : {}),
      destination,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    },
    buildHookContext({
      destination,
      sessionKey: params.sessionKey,
      runId: params.runId,
    }),
  );

  const payload = (result?.payload as ReplyPayload | undefined) ?? params.payload;
  if (result?.decision === "cancel") {
    return {
      decision: "cancel",
      payload,
      destination,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }
  if (result?.decision === "reroute") {
    return {
      decision: "reroute",
      payload,
      destination: {
        channel: result.destination.channel,
        to: result.destination.to,
        conversationId: result.destination.to,
        ...(result.destination.accountId ? { accountId: result.destination.accountId } : {}),
        ...(result.destination.threadId !== undefined
          ? { threadId: result.destination.threadId }
          : {}),
        path: destination.path,
      },
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }
  return {
    decision: "allow",
    payload,
    destination,
    ...(result?.reason ? { reason: result.reason } : {}),
  };
}
