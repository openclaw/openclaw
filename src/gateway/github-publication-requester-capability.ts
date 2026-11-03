import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-operator-authority.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import type { GitHubPublicationSourceCapability } from "./github-publication-source.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/shared-types.js";
/** @deprecated Use GitHubPublicationRequesterPolicyV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

/** @deprecated Use GitHubPublicationRequesterV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
  }>;

/** Prepared host policy and a required live source capability for worker-owned writes. */
export type GitHubPublicationRequesterPolicyV2 = GitHubPublicationRequesterPolicy &
  Readonly<{
    version: 2;
    signal: AbortSignal;
    prepareSource(
      selector: GitHubPublicationSourceSelector,
    ): Promise<GitHubPublicationSourceCapability>;
  }>;
export type GitHubPublicationRequesterV2 = GitHubPublicationRequesterPolicyV2 &
  Pick<GitHubPublicationRequester, "assertInvocationCurrent">;

const workerRequesters = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationWorkerRequesters"),
  () => new WeakSet<GitHubPublicationRequesterPolicy>(),
);
/** Registration proves this process prepared the live source-capable requester. */
export function registerGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): void {
  workerRequesters.add(requester);
}
/** Classify before invoking released assertions; failed worker work never selects legacy. */
export function isGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): requester is GitHubPublicationRequesterPolicyV2 {
  return workerRequesters.has(requester);
}

/** Input captured from the admitted caller, with the original access and invocation owners. */
export type GitHubPublicationRequesterPreparation = (
  options: {
    client: GatewayClient | null;
    context: Pick<
      GatewayRequestContext,
      "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
    >;
    hasCurrentClientAuthority?: () => boolean;
    independentContinuation?: true;
    sourceAuthority?: Readonly<{
      assertCurrent: () => void;
      signal?: AbortSignal;
      gatewayAccessGrant?: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
      release?: () => void;
    }> | null;
    invocationAuthority?: Readonly<{
      assertCurrent: () => void;
      signal?: AbortSignal;
      release?: () => void;
    }>;
  } & Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: { sessionKey: string; agentId: string },
) => Promise<{ requester: GitHubPublicationRequesterV2; release: () => void }>;
