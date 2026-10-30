import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { currentGitHubPublicationConfig } from "../github-publication-availability.js";

/** Checkout requires identity admission; optional publication discovery cannot authorize anonymous Git. */
export async function prepareRepositoryGitHubIdentity(agentId: string, assertCurrent: () => void) {
  const config = currentGitHubPublicationConfig();
  try {
    return await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId,
      getCurrentConfig: currentGitHubPublicationConfig,
      assertActive: assertCurrent,
      refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      allowAnonymous: true,
    });
  } catch (error) {
    assertCurrent();
    // Credential storage/subprocess failures need safe, actionable identity guidance.
    throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
  }
}
