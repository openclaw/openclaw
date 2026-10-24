import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import {
  isInternalOwnerRequester,
  resolveRequesterToolPolicies,
} from "../agents/requester-tool-policy.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import { withPreparedSessionCapabilityRead } from "../agents/subagents/spawn/subagent-session-store.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readScheduledSenderBit } from "../cron/execution-context-registry.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";

/** Preserve trusted channel policy and require verified lineage for completion grants. */
export async function resolveGatewayRequesterToolPolicies(
  params: Pick<
    McpLoopbackRequestContext,
    | "conversationToolPolicy"
    | "requesterOrigin"
    | "operatorProfileId"
    | "conversationId"
    | "chatType"
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
  const isOwnerInternalSession = options.nodeExecSurface && isInternalOwnerRequester(params);
  const policies = await withPreparedSessionCapabilityRead(() =>
    resolveRequesterToolPolicies({
      config: params.cfg,
      requesterOrigin: params.requesterOrigin,
      conversationId: params.conversationId,
      chatType: params.chatType,
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
    }),
  );
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

/**
 * The sender bit a Gateway-resolved surface applies, and owner-only tools it
 * adds to the denial. A scheduled CLI run takes the same sender bit as its
 * embedded twin from its context; the grant coerces an absent bit to `false`.
 * The loopback carries no self-scoped automations grant, so a scheduled CLI run
 * keeps the automations denial whatever its owner bit.
 */
export function resolveGatewaySenderAuthority(
  params: { senderIsOwner?: boolean; admittedRunContext?: AdmittedRunContext },
  surface: "http" | "loopback",
): { senderIsOwner?: boolean; scheduledOwnerDeny: string[] } {
  const scheduled =
    surface === "loopback" ? readScheduledSenderBit(params.admittedRunContext) : undefined;
  return scheduled
    ? { senderIsOwner: scheduled.senderIsOwner, scheduledOwnerDeny: [AUTOMATIONS_TOOL_NAME] }
    : { senderIsOwner: params.senderIsOwner, scheduledOwnerDeny: [] };
}

/** HTTP callers start with the default surface denies that `gateway.tools.allow` has not lifted. */
export function resolveDefaultGatewayHttpDeny(
  surface: "http" | "loopback",
  allow: readonly string[] | undefined,
): string[] {
  return surface === "http"
    ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter(
        // Config allow entries may use legacy tool names (e.g. "cron");
        // normalize both sides so they still lift the matching default deny.
        (name) =>
          !allow?.some(
            (allowed) => normalizeToolPolicyName(allowed) === normalizeToolPolicyName(name),
          ),
      )
    : [];
}
