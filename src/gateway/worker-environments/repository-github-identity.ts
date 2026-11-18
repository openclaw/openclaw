import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { currentGitHubPublicationConfig } from "../github-publication-availability.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";

/** Checkout requires identity admission; optional publication discovery cannot authorize anonymous Git. */
export async function prepareRepositoryGitHubIdentity(
  agentId: string,
  assertCurrent: () => void,
  options?: {
    readNativeCredential?: GitHubCredentialReader;
    retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
    repositoryUrl: string;
  },
) {
  // Worker dispatch supplies source options; local materialization keeps its own admission.
  const assertReadCurrent = options
    ? composeSessionSourceAssertion(
        [captureExternalSessionCommitGuard(assertCurrent)],
        (assertSources) => {
          assertSources();
          assertRepositoryDispatchAdmission(
            options.readNativeCredential,
            currentGitHubPublicationConfig(),
          );
        },
      )
    : assertCurrent;
  const config = currentGitHubPublicationConfig();
  try {
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId,
      getCurrentConfig: currentGitHubPublicationConfig,
      assertActive: assertReadCurrent,
      readNativeCredential: options?.readNativeCredential,
      allowAppInstallation: options?.retainCredentialCleanup !== undefined,
      requestedRepository: options
        ? new URL(options.repositoryUrl).pathname.replace(/^\/|\.git$/gu, "")
        : undefined,
      refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      allowAnonymous: true,
    });
    if (identity.revoke) {
      options?.retainCredentialCleanup?.(identity.revoke);
    }
    assertReadCurrent();
    return identity;
  } catch (error) {
    assertReadCurrent();
    // Credential storage/subprocess failures need safe, actionable identity guidance.
    throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
  }
}
