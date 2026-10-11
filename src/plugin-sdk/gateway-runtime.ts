import type { prepareGitHubPublicationRequesterV2 as PrepareGitHubPublicationRequester } from "../gateway/github-publication-requester.js";
import type { preparePersonalGitHubSessionActionV2 as PreparePersonalGitHubSessionAction } from "../gateway/server-methods/github-personal-authorization.js";

export { addGatewayClientOptions, callGatewayFromCli } from "../cli/gateway-rpc.js";
export type { GatewayRpcOpts } from "../cli/gateway-rpc.js";
export { isGatewayClientRequestError, isGatewayTransportError } from "../gateway/call.js";
// Plugin CLIs echo gateway URLs/close reasons into operator-visible errors;
// they must use the canonical redactor so URL userinfo/tokens never print.
export { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
export { isLoopbackHost } from "../gateway/net.js";
export { resolveHostedPluginSurfaceUrl } from "../gateway/hosted-plugin-surface-url.js";
export type { HostedPluginSurfaceUrlParams } from "../gateway/hosted-plugin-surface-url.js";
export {
  buildPluginNodeCapabilityScopedHostUrl,
  DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS,
  mintPluginNodeCapabilityToken,
  normalizePluginNodeCapabilityScopedUrl,
  PLUGIN_NODE_CAPABILITY_PATH_PREFIX,
} from "../gateway/plugin-node-capability.js";
export type { NormalizedPluginNodeCapabilityUrl } from "../gateway/plugin-node-capability.js";
export {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
export type { NodeSession } from "../gateway/node-registry.js";
export { resolveNodeFromNodeList } from "../shared/node-resolve.js";
export type { NodeMatchCandidate } from "../shared/node-match.js";
export {
  parseGatewayPayload as safeParseJson,
  respondUnavailableOnNodeInvokeError,
} from "../gateway/server-methods/nodes.helpers.js";
export type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
export { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";
export { resolveGatewayAuth } from "../gateway/auth.js";

export { GatewayClient } from "../gateway/client.js";
export { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
// Compatibility for @tencent-connect/openclaw-qqbot@2.0.3. Remove after the pinned
// package migrates its approval handler to the dedicated approval runtime SDK.
export { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";

export { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";

export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export {
  captureLocalStateMutationGuard,
  runWithLocalStateMutationOwner,
} from "../gateway/server-methods/local-state-owner.js";
export { isImplicitLocalGatewayTargetFromCli } from "../cli/gateway-rpc.js";

export type {
  GitHubPublicationRequesterPolicyV2,
  GitHubPublicationRequesterV2,
} from "../gateway/github-publication-requester.js";
export type {
  GitHubPublicationClaimRequestV2,
  GitHubPublicationSessionRequestV2,
} from "../gateway/github-publication-coordinator-methods.js";
export type { PersonalGitHubSessionActionV2 } from "../gateway/github-personal-publication.js";

/** Prepare a host-owned requester from this handler's admitted Gateway authority. */
export async function prepareGitHubPublicationRequesterV2(
  ...args: Parameters<typeof PrepareGitHubPublicationRequester>
): ReturnType<typeof PrepareGitHubPublicationRequester> {
  const { prepareGitHubPublicationRequesterV2: prepare } =
    await import("../gateway/github-publication-requester.js");
  return await prepare(...args);
}

/** Prepare personal publication authority and release it when the handler settles. */
export async function preparePersonalGitHubSessionActionV2(
  ...args: Parameters<typeof PreparePersonalGitHubSessionAction>
): ReturnType<typeof PreparePersonalGitHubSessionAction> {
  const { preparePersonalGitHubSessionActionV2: prepare } =
    await import("../gateway/server-methods/github-personal-authorization.js");
  return await prepare(...args);
}

export {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "../gateway/channel-status-patches.js";

export { parseTimeoutMsWithFallback } from "../cli/parse-timeout.js";
