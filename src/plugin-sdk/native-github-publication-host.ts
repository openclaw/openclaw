/** Native GitHub publication custody: fixed receipt and wire contracts, with plugin-owned transport. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
/** Gateway lifetime and authenticated personal-caller operations for managed repository accounts. */
import { readWorkspacePublicationHost } from "../gateway/workspace-publication-binding.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";

export {
  appendGitHubPublicationMessage as appendNativeGitHubPublicationMessage,
  hasGitHubPublicationMessageFooter as hasNativeGitHubPublicationMessageFooter,
} from "../gateway/repository-publication-message.js";
export { parseGitHubPublicationBaseBranch as nativeGitHubPublicationBaseBranch } from "../gateway/github-publication-base.js";
export {
  performRepositoryPublicationGit as performNativeGitHubPublicationGit,
  type RepositoryPublicationGitTransfer as NativeGitHubPublicationGitTransfer,
} from "../gateway/repository-publication-git-transfer.js";
export type {
  RepositoryPublicationProvider as NativeGitHubPublicationProvider,
  RepositoryPublicationActionInput as NativeGitHubPublicationActionInput,
  RepositoryPublicationActionResult as NativeGitHubPublicationActionResult,
  RepositoryPublicationPublisher as NativeGitHubPublicationPublisher,
  RepositoryPublicationTarget as NativeGitHubPublicationTarget,
  RepositoryPublicationRequestFacts as NativeGitHubPublicationRequestFacts,
  RepositoryPublicationSnapshot as NativeGitHubPublicationSnapshot,
  RepositoryPublicationContent as NativeGitHubPublicationContent,
  RepositoryPublicationRemoteFacts as NativeGitHubPublicationRemoteFacts,
  RepositoryPublicationFailure as NativeGitHubPublicationFailure,
} from "../gateway/repository-publication-contract.js";
export { RepositoryPublicationFailureError as NativeGitHubPublicationFailureError } from "../gateway/github-publication-errors.js";
export type {
  RepositoryPublicationPersonalAction as NativeGitHubPublicationPersonalAction,
  RepositoryPublicationPersonalBinding as NativeGitHubPublicationPersonalBinding,
} from "../gateway/repository-publication-contract.js";
export {
  RepositoryPublicationChangePermissionError as NativeGitHubPublicationChangePermissionError,
  RepositoryPublicationRequesterUnavailableError as NativeGitHubPublicationRequesterUnavailableError,
} from "../gateway/github-publication-errors.js";
export type { RepositoryPublicationObjectPlan as NativeGitHubPublicationObjectPlan } from "../gateway/repository-publication-contract.js";
export type { RepositoryPublicationApi as NativeGitHubPublicationApi } from "../gateway/workspace-publication-provider.js";

export type { RepositoryWorkerIdentity as NativeGitHubWorkerIdentity } from "../gateway/repository-publication-contract.js";
export { performRepositoryWorkerIdentity as performNativeGitHubWorkerIdentity } from "../gateway/repository-worker-identity-transfer.js";

export type { SessionGitHubPullRequestBinding as NativeGitHubPullRequestBinding } from "../config/sessions/types.js";

export type { RepositoryPublicationOwnPullRequestReader as NativeGitHubPublicationOwnPullRequestReader } from "../gateway/repository-publication-contract.js";
export {
  RepositoryPublicationAuthorityError as NativeGitHubPublicationAuthorityError,
  RepositoryPublicationSessionChangedError as NativeGitHubPublicationSessionChangedError,
  RepositoryPublicationWorkspaceChangedError as NativeGitHubPublicationWorkspaceChangedError,
} from "../gateway/github-publication-errors.js";

export type { RepositoryPublicationContentFactsV1 as NativeGitHubPublicationContentFactsV1 } from "../gateway/repository-publication-content-contract.js";
export type { RepositoryPublicationContentHostV1 as NativeGitHubPublicationContentHostV1 } from "../gateway/repository-publication-content-contract.js";
export { RepositoryPublicationCreditChangedError as NativeGitHubPublicationCreditChangedError } from "../gateway/repository-publication-content-contract.js";

export type { NativeGitHubPublisherProvenance } from "../gateway/repository-publication-contract.js";

export function captureNativeGitHubServiceHost():
  | {
      identity: AbortSignal;
      getConfig: () => OpenClawConfig;
      publicationAvailable: boolean;
      assertCurrent: () => void;
    }
  | undefined {
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  if (!context || !resolveGatewayContext) {
    return undefined;
  }
  const identity = getGatewayServiceLifetime({ resolveGatewayContext });
  if (getGatewayServiceLifetime(context) !== identity) {
    throw new Error("Repository account service has an incompatible Gateway owner.");
  }
  const assertCurrent = () => {
    identity.throwIfAborted();
    if (getGatewayServiceLifetime({ resolveGatewayContext }) !== identity) {
      throw new Error("Repository account service Gateway owner was replaced.");
    }
  };
  return {
    identity,
    getConfig: context.getRuntimeConfig,
    publicationAvailable: Boolean(readWorkspacePublicationHost(context)),
    assertCurrent,
  };
}

/** Prepare canonical personal authority without eagerly loading the account/publication graph. */
export async function prepareGatewayNativeGitHubPersonalCallerV2(
  ...args: Parameters<
    typeof import("../gateway/server-methods/personal-profile-authorization.js").preparePersonalProfileAction
  >
): ReturnType<
  typeof import("../gateway/server-methods/personal-profile-authorization.js").preparePersonalProfileAction
> {
  const { preparePersonalProfileAction } =
    await import("../gateway/server-methods/personal-profile-authorization.js");
  return preparePersonalProfileAction(...args);
}

/** Publication installation loads instance machinery only for an admitted service start. */
export async function installNativeGitHubPublicationProvider(
  ...args: Parameters<
    typeof import("../gateway/native-github-publication-install.js").installRepositoryPublicationProvider
  >
): ReturnType<
  typeof import("../gateway/native-github-publication-install.js").installRepositoryPublicationProvider
> {
  const runtime = await import("../gateway/native-github-publication-install.js");
  return await runtime.installRepositoryPublicationProvider(...args);
}
