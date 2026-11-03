/** Native GitHub review admission over host-owned common session/source observations. */
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  hasCurrentPluginInstanceAuthority,
  wrapCurrentPluginInstance,
} from "../plugins/plugin-instance-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { getPluginServiceSchedulerBinding } from "../plugins/service-scheduler-binding.js";
export type {
  PreparedRepositorySessionRead as PreparedNativeGitHubSessionRead,
  RepositorySessionObservation,
  RepositorySessionIdentity,
  RepositorySessionSourceScope,
  RepositoryTaskPublications,
} from "../gateway/repository-session-read.types.js";
export type {
  RepositorySessionReads as NativeGitHubSessionReads,
  RepositorySessionReadChange as NativeGitHubSessionReadChange,
  RepositorySessionPresentation as NativeGitHubSessionPresentation,
} from "../gateway/repository-session-read.types.js";

/** Create once in an admitted service; request and scheduler calls borrow this actual owner. */
export function createNativeGitHubSessionReads() {
  const scheduler = getPluginServiceSchedulerBinding()?.();
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  const instance = pluginInstanceInvocation.getStore()?.instance;
  const pluginId = instance?.pluginId;
  if (
    !scheduler ||
    !resolveGatewayContext ||
    !context?.repositorySessions ||
    !instance ||
    !pluginId ||
    !hasCurrentPluginInstanceAuthority(pluginId)
  ) {
    throw new Error("Repository session reads require a bound Gateway plugin service");
  }
  const gateway = getGatewayServiceLifetime({ resolveGatewayContext });
  const serviceSignal = AbortSignal.any([scheduler.signal, gateway, instance.lifecycle.signal]);
  const assertCurrent = () => {
    serviceSignal.throwIfAborted();
    if (getGatewayServiceLifetime({ resolveGatewayContext }) !== gateway) {
      throw new Error("Repository session Gateway owner changed");
    }
  };
  const host = context.repositorySessions.bindService(serviceSignal, assertCurrent);
  const { withRequestRead: _withRequestRead, ...reads } = host;
  return Object.freeze({
    ...reads,
    installPresentation: (
      provider: import("../gateway/repository-session-read.types.js").RepositorySessionPresentation,
    ) => host.installPresentation(wrapCurrentPluginInstance(provider)),
  });
}

export type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckStep,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
  ControlUiSessionPullRequestsChanged,
} from "../gateway/control-ui-contract.js";
export {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../gateway/control-ui-contract.js";

export { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
export type { SessionGitHubPullRequestBinding as NativeGitHubPullRequestBinding } from "../config/sessions/types.js";

/** Borrow only the current admitted request; client and Factory proof issuance stay host-owned. */
export async function captureNativeGitHubSessionRequestRead() {
  const runtime = await import("../gateway/control-ui-session-pr-request-read.js");
  return runtime.captureRepositorySessionRequestRead();
}

export type { RepositoryReadCredentialPreparation as NativeGitHubReadCredentialPreparation } from "../gateway/repository-session-read.types.js";

export { parseGitHubRemoteUrl } from "../gateway/github-remote.js";
