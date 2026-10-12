import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { resolveRequesterToolPolicies } from "../agents/requester-tool-policy.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";

/** Preserve trusted channel policy and require verified lineage for completion grants. */
export function resolveGatewayRequesterToolPolicies(
  params: Pick<
    McpLoopbackRequestContext,
    | "conversationToolPolicy"
    | "spawnedBy"
    | "messageProvider"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
    | "channelContext"
    | "senderName"
    | "senderUsername"
    | "senderE164"
    | "inputProvenance"
    | "trustedInternalHandoff"
    | "sessionId"
    | "modelProvider"
    | "modelId"
    | "scheduledToolPolicy"
  > & {
    cfg: OpenClawConfig;
    senderIsOwner?: boolean;
  },
  options: {
    runtimePolicySessionKey: string;
    policyAgentId: string;
    nodeExecSurface: boolean;
    accountId?: string;
  },
) {
  // Only immutable Gateway-launched grants can opt into node exec. Match the
  // embedded runner's wildcard sender policy while preserving owner WebChat.
  const isOwnerInternalSession =
    options.nodeExecSurface &&
    params.senderIsOwner === true &&
    normalizeMessageChannel(params.messageProvider) === INTERNAL_MESSAGE_CHANNEL;
  const policies = resolveRequesterToolPolicies({
    config: params.cfg,
    conversationPolicy: pickSandboxToolPolicy(params.conversationToolPolicy),
    sessionKey: options.runtimePolicySessionKey,
    subagentSessionKey: options.runtimePolicySessionKey,
    agentId: options.policyAgentId,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: options.accountId ?? null,
    senderId: params.channelContext?.sender?.id,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    sessionId: params.sessionId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    senderPolicyMode: params.scheduledToolPolicy
      ? "never"
      : options.nodeExecSurface
        ? isOwnerInternalSession
          ? "never"
          : "always"
        : "when-sender-id",
    groupPolicySessionKey: params.scheduledToolPolicy?.ownerSessionKey,
    requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
  });
  if (params.trustedInternalHandoff && policies.requesterPolicySource !== "completion-handoff") {
    throw new Error("CLI completion tool grant no longer matches its requester policy");
  }
  return policies;
}

/** Construction cancellation must not become the lifetime of a cached tool. */
export function captureGatewayToolResolutionAuthority(
  params: {
    admittedRunContext?: AdmittedRunContext;
    isGrantCurrent?: () => boolean;
    assertInvocationCurrent?: () => void;
  },
  assertPreparationCurrent?: () => void,
) {
  const assertRunCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext)
    : undefined;
  const assertInvocationCurrent = () => {
    if (params.isGrantCurrent && !params.isGrantCurrent()) {
      throw new Error("Gateway tool invocation grant is no longer active");
    }
    params.assertInvocationCurrent?.();
    assertRunCurrent?.();
  };
  return {
    assertInvocationCurrent,
    assertCurrent: () => {
      assertPreparationCurrent?.();
      assertInvocationCurrent();
    },
  };
}
