import { expectTypeOf } from "vitest";
import type { GitHubPublicationRequesterPreparation } from "../../src/gateway/github-publication-requester-capability.js";
import type { createGitHubPublicationCoordinator } from "../../src/gateway/github-publication.js";
import type { captureGatewayOperatorRunAuthority } from "../../src/gateway/operator-run-authority.js";
import type {
  RepositoryPublicationApi,
  RepositoryPublicationProvider,
} from "../../src/gateway/repository-publication-contract.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/shared-types.js";

// The concrete coordinator still infers its output; the leaf must preserve every consumed method.
type InferredApi = Pick<
  ReturnType<typeof createGitHubPublicationCoordinator>,
  | "preparePullRequest"
  | "refreshBase"
  | "requestForSessionV2"
  | "requestPersonalForSessionV2"
  | "confirmPersonalV2"
  | "preparePersonalStatus"
  | "personalStatusAsync"
  | "personalPending"
  | "sharedStatus"
  | "latestShared"
  | "latestPublishedShared"
> &
  Pick<
    RepositoryPublicationProvider,
    | "supportsOrigin"
    | "inspectPullRequest"
    | "performPullRequestAction"
    | "readOptionsIdentity"
    | "preparePersonalAccountStatus"
    | "isPublicationSuperseded"
  >;
expectTypeOf<RepositoryPublicationApi>().toEqualTypeOf<InferredApi>();
expectTypeOf<InferredApi>().toEqualTypeOf<RepositoryPublicationApi>();

// Compare against the independent native authority owner, not the preparer's own annotation.
type NativeRequesterInput = Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
  Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">;
expectTypeOf<
  Parameters<GitHubPublicationRequesterPreparation>[0]
>().toEqualTypeOf<NativeRequesterInput>();
expectTypeOf<NativeRequesterInput>().toEqualTypeOf<
  Parameters<GitHubPublicationRequesterPreparation>[0]
>();
