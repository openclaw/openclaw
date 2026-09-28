import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { GatewayContextResolver } from "./types.js";

export type TrustedGroupMetadata = {
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

export function normalizeTrustedGroupMetadata(value?: {
  groupId?: unknown;
  groupChannel?: unknown;
  groupSpace?: unknown;
  space?: unknown;
}): TrustedGroupMetadata {
  return {
    groupId: normalizeOptionalString(value?.groupId),
    groupChannel: normalizeOptionalString(value?.groupChannel),
    groupSpace: normalizeOptionalString(value?.groupSpace ?? value?.space),
  };
}

function resolveSessionKeyGroupId(sessionKey: string): string | undefined {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const conversation = parseRawSessionConversationRef(baseSessionKey ?? sessionKey);
  if (!conversation || (conversation.kind !== "group" && conversation.kind !== "channel")) {
    return undefined;
  }
  return conversation.rawId;
}

export function resolveTrustedGroupMetadata(params: {
  sessionKey: string;
  spawnedBy?: string;
  stored: TrustedGroupMetadata;
  inherited?: TrustedGroupMetadata;
}): TrustedGroupMetadata {
  return {
    // Group trust can be inherited from the parent run or recovered from conversation-shaped keys.
    groupId:
      params.stored.groupId ??
      params.inherited?.groupId ??
      resolveSessionKeyGroupId(params.sessionKey) ??
      (params.spawnedBy ? resolveSessionKeyGroupId(params.spawnedBy) : undefined),
    groupChannel: params.stored.groupChannel ?? params.inherited?.groupChannel,
    groupSpace: params.stored.groupSpace ?? params.inherited?.groupSpace,
  };
}

export function requestGroupMatchesTrusted(params: {
  requestGroupId?: string;
  trustedGroupId?: string;
}): boolean {
  const requestGroupId = params.requestGroupId?.trim();
  if (!requestGroupId) {
    // Missing group metadata is accepted so non-group channels keep the same send path.
    return true;
  }
  return Boolean(params.trustedGroupId && requestGroupId === params.trustedGroupId);
}

export async function registerPluginSubagentRunFromGateway(params: {
  cfg: OpenClawConfig;
  runId: string;
  childSessionKey: string;
  task: string;
  requester?: PluginSubagentRequesterContext;
  pluginId?: string;
  gatewayContextResolver?: GatewayContextResolver;
  assertCurrent: () => void;
}): Promise<void> {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return;
  }
  const ownerSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: resolveAgentIdFromSessionKey(childSessionKey),
  });
  const requesterSessionKey = params.requester?.sessionKey ?? ownerSessionKey;
  const { adoptPausedSubagentRunForFollowUp, registerSubagentRun } =
    await import("../../agents/subagents/registry/subagent-registry.js");
  params.assertCurrent();
  // A follow-up aimed at a session paused by sessions_yield continues that run.
  // Registering a sibling row here would reassign the requester to this agent's
  // own main session and leave the original requester waiting behind a row that
  // can no longer announce. A follow-up that names its own requester is opting
  // into its own delivery, so it registers normally rather than silently
  // inheriting the paused row's audience.
  if (
    !params.requester &&
    adoptPausedSubagentRunForFollowUp({
      childSessionKey,
      runId: params.runId,
      task: params.task,
      ...(params.gatewayContextResolver
        ? { gatewayContextResolver: params.gatewayContextResolver }
        : {}),
    })
  ) {
    return;
  }
  await registerSubagentRun(
    {
      runId: params.runId,
      childSessionKey,
      controllerSessionKey: ownerSessionKey,
      requesterSessionKey,
      requesterOrigin: params.requester?.origin,
      requesterDisplayKey: params.requester ? requesterSessionKey : "main",
      task: params.task,
      cleanup: "keep",
      ...(params.pluginId ? { label: `plugin:${params.pluginId}` } : {}),
      expectsCompletionMessage: params.requester !== undefined,
      spawnMode: "run",
      ...(params.gatewayContextResolver
        ? { gatewayContextResolver: params.gatewayContextResolver }
        : {}),
    },
    { assertCurrent: params.assertCurrent },
  );
}
