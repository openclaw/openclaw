import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { PreparedGitHubSourceReadIdentity } from "../agents/github-read-identity.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
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
  // The agent's account, own or shared, serves its reads. Without a managed
  // selection that is the detected GitHub CLI login, unless an explicit web app
  // service credential owns these reads.
  const native =
    !managed &&
    resolveConfiguredGitHubHost(config) === "github.com" &&
    config.gateway?.controlUi?.github?.token === undefined;
  assertActive();
  let prepared: PreparedGitHubSourceReadIdentity | undefined;
  if (managed || native) {
    try {
      prepared = await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        allowStale: true,
        allowAnonymous: true,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      });
    } catch (error) {
      // A managed selection fails visibly. A broken detected login keeps the
      // previous environment/anonymous public access instead of blocking reads.
      if (managed || !(error instanceof GitHubIdentityError)) {
        throw error;
      }
    }
  }
  // Without a detected login, keep the cheap anonymous path; an anonymous native
  // identity would re-run the gh absence probe on every GitHub dispatch.
  const identity = prepared?.token === undefined ? undefined : prepared;
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
