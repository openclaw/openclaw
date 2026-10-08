import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import { prepareGitHubReadIdentity } from "../agents/github-tool-identity.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import type { ControlUiSessionPrReadContext } from "./control-ui-session-pr-read.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import { gitHubPublicApi } from "./github-public-api.js";

type MergeStatus = NonNullable<ControlUiSessionPullRequest["merge"]>;
const observations = createRetainedCache<{
  expiresAt: number;
  elapsedExpiresAt: number;
  status: MergeStatus;
}>();
const isFinal = ({ status }: MergeStatus) => status !== "pending" && status !== "unavailable";
const unavailable = (): MergeStatus => ({
  status: "unavailable",
  message: "Merge status is unavailable; check the pull request on GitHub.",
});

function currentConfig() {
  const config = getRuntimeConfigSnapshot();
  if (!config) {
    throw new Error("GitHub runtime configuration is unavailable");
  }
  return config;
}

/** Observe the existing merge owner; reading the composer never submits or resumes a merge. */
export async function observeSessionPullRequestMerges(
  context: GitCheckoutContext,
  pullRequests: ControlUiSessionPullRequest[],
  read: ControlUiSessionPrReadContext,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<{ pullRequests: ControlUiSessionPullRequest[]; reconcile: boolean }> {
  const root = context.root;
  // Remote-only workspaces do not deliver the native script's private Git refs.
  if (!root) {
    return { pullRequests, reconcile: false };
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    read.assertCurrent();
  };
  assertCurrent();
  const attempts = await Promise.all(
    pullRequests.map(async (pr) => {
      if (!pr.headSha || (pr.state !== "open" && pr.state !== "draft")) {
        return null;
      }
      const target = {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        headSha: pr.headSha,
      };
      const raw = await runGitReadOperation(
        {
          type: "repository.ref-file",
          input: {
            root,
            ref: gitHubPublicApi.githubAsyncMergeReceiptRef(pr.number),
            path: "outcome.json",
          },
        },
        { signal },
      );
      assertCurrent();
      const receipt = raw ? gitHubPublicApi.parseGitHubAsyncMergeReceipt(raw, target) : null;
      return receipt ? { target, receipt } : null;
    }),
  );
  if (!attempts.some(Boolean)) {
    return { pullRequests, reconcile: false };
  }
  try {
    const config = currentConfig();
    const host = context.host ?? "github.com";
    const apiBaseUrl =
      host === "github.com" ? "https://api.github.com" : resolveConfiguredGitHubApiBaseUrl(config);
    const assertIdentityCurrent = () => {
      assertCurrent();
      const current = currentConfig();
      if (
        host !== "github.com" &&
        (resolveConfiguredGitHubHost(current) !== host ||
          resolveConfiguredGitHubApiBaseUrl(current) !== apiBaseUrl)
      ) {
        throw new Error("GitHub merge request host changed");
      }
    };
    assertIdentityCurrent();
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId: read.target.params.agentId,
      ...(host === "github.com" ? { issuer: "github.com" as const } : {}),
      getCurrentConfig: currentConfig,
      assertActive: assertIdentityCurrent,
      refresh: () => requestCurrentGitHubOAuthRefresh(read.target.params.agentId),
    });
    let reconcile = false;
    const result = await Promise.all(
      pullRequests.map(async (pr, index) => {
        const attempt = attempts[index];
        if (!attempt) {
          return pr;
        }
        const key = JSON.stringify([
          read.target.identity,
          read.sourceIdentity,
          root,
          apiBaseUrl,
          identity.cacheScope,
          attempt.target,
          attempt.receipt,
        ]);
        const cached = observations.get(key);
        const observed =
          cached && cached.expiresAt > Date.now() && cached.elapsedExpiresAt > performance.now()
            ? cached.status
            : await gitHubPublicApi.readGitHubAsyncMergeStatus(attempt.target, attempt.receipt, {
                identity,
                apiBaseUrl,
                signal,
                fetchImpl,
              });
        assertIdentityCurrent();
        // Overlapping direct and subscribed reads may finish out of order. Once this
        // request has a final outcome, a late pending/error response cannot replace it.
        const current = observations.get(key);
        const merge = current && isFinal(current.status) ? current.status : observed;
        reconcile ||= merge.status === "merged" && current?.status.status !== "merged";
        if (merge !== current?.status) {
          // Completed async results are final; keep them in the bounded identity-scoped cache
          // so endpoint expiry cannot erase the outcome. Transient reads retain quota backoff.
          const maxAge = isFinal(merge) ? Infinity : Math.max(5_000, merge.retryAfterMs ?? 0);
          observations.set(key, {
            // Either clock can expire transient data: wall time covers sleep, elapsed
            // time prevents backward clock adjustments from extending a pending pulse.
            expiresAt: Date.now() + maxAge,
            elapsedExpiresAt: performance.now() + maxAge,
            status: merge,
          });
        }
        return { ...pr, merge };
      }),
    );
    return await identity.start(() => {
      assertIdentityCurrent();
      return { pullRequests: result, reconcile };
    });
  } catch {
    assertCurrent();
    return {
      pullRequests: pullRequests.map((pr, index) =>
        attempts[index] ? { ...pr, merge: unavailable() } : pr,
      ),
      reconcile: false,
    };
  }
}
