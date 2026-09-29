import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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
  assertCurrent: () => SessionEntry | undefined;
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
  const sessionEntry = params.assertCurrent();
  // Resume a yielded run with its original audience unless the follow-up names
  // a requester and therefore owns a separate delivery.
  if (
    !params.requester &&
    adoptPausedSubagentRunForFollowUp({
      childSessionKey,
      runId: params.runId,
      task: params.task,
      gatewayContextResolver: params.gatewayContextResolver,
    })
  ) {
    return;
  }
  await registerSubagentRun(
    {
      runId: params.runId,
      childSessionKey,
      sessionEntry,
      controllerSessionKey: ownerSessionKey,
      requesterSessionKey,
      requesterOrigin: params.requester?.origin,
      requesterDisplayKey: params.requester ? requesterSessionKey : "main",
      task: params.task,
      cleanup: "keep",
      ...(params.pluginId ? { label: `plugin:${params.pluginId}` } : {}),
      expectsCompletionMessage: params.requester !== undefined,
      spawnMode: "run",
      gatewayContextResolver: params.gatewayContextResolver,
    },
    { assertCurrent: params.assertCurrent },
  );
}
