import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { currentGitHubPublicationConfig } from "../github-publication-availability.js";

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
  const config = currentGitHubPublicationConfig();
  try {
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId,
      getCurrentConfig: currentGitHubPublicationConfig,
      assertActive: assertCurrent,
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
    assertCurrent();
    return identity;
  } catch (error) {
    assertCurrent();
    // Credential storage/subprocess failures need safe, actionable identity guidance.
    throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
  }
}
