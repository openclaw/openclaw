import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { readNativeGitHubConfiguration } from "../agents/github-read-identity.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import type { ControlUiGitHubPreviewIdentity } from "./github-public-api.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** UI and agent readers share selection; each caller supplies its own live authority. */
export async function prepareGitHubReaderIdentity(
  context: GatewayRequestContext,
  agentId: string,
  assertActive: () => void,
) {
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    if (resolveConfiguredGitHubHost(current) !== "github.com") {
      return undefined;
    }
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
  const managed = configuredIdentity() !== undefined;
  // Without a managed selection, the agent's shared account is the detected
  // GitHub CLI login. Service and environment credentials keep their existing
  // optional-auth path, and the lifecycle's periodic native sample keeps
  // signed-out hosts from probing gh on every read.
  const native =
    !managed &&
    resolveConfiguredGitHubHost(config) === "github.com" &&
    config.gateway?.controlUi?.github?.token === undefined &&
    !process.env.GH_TOKEN?.trim() &&
    !process.env.GITHUB_TOKEN?.trim() &&
    readNativeGitHubConfiguration("github.com") === "configured";
  assertActive();
  let identity: ControlUiGitHubPreviewIdentity | undefined;
  if (managed || native) {
    try {
      const prepared = await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        allowStale: true,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      });
      // Like environment tokens, a rejected or rate-limited CLI login may retry
      // public reads anonymously; managed selections stay strict.
      identity = managed ? prepared : { ...prepared, optionalAuth: true };
    } catch (error) {
      // A managed selection fails visibly. A broken detected login keeps the
      // previous anonymous public access instead of blocking reads.
      if (managed || !(error instanceof GitHubIdentityError)) {
        throw error;
      }
    }
  }
  return {
    identity,
    assertSelected:
      identity?.assertSelected ??
      (() => {
        assertActive();
        if (configuredIdentity()) {
          throw new GitHubIdentityError("changed");
        }
      }),
  };
}
