import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** The login edge accepts only this Gateway-verified account and current request owner. */
export function factoryGitHubActorEnvironment(
  client: GatewayClient | null | undefined,
  sessionKey: string,
  purpose?: Extract<FactoryGitHubProofClaim["purpose"], "session-item-read">,
): NodeJS.ProcessEnv | undefined {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return undefined;
  }
  client?.connectionSignal?.throwIfAborted();
  const accountId = client?.authenticatedFactoryGitHubAccountId;
  const scopes = client?.connect?.scopes ?? [];
  if (
    client?.invalidated ||
    client?.connect.role !== "operator" ||
    !Number.isSafeInteger(accountId) ||
    !accountId ||
    !client?.authenticatedUserProfile?.profileId ||
    (!scopes.includes("operator.write") &&
      !scopes.includes("operator.admin") &&
      !(purpose === "session-item-read" && scopes.includes("operator.read"))) ||
    (purpose === "session-item-read" &&
      (!client.connId ||
        client.invalidated ||
        client.connectionSignal?.aborted ||
        client.internal?.authenticatedOperator !== true ||
        client.internal.syntheticClient ||
        client.internal.agentRuntimeIdentity ||
        client.internal.agentToolCaller)) ||
    !sessionKey
  ) {
    throw new Error(
      "A current verified GitHub operator and session are required for repository access.",
    );
  }
  return {
    ...process.env,
    GH_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    OPENCLAW_FACTORY_GITHUB_PROOF: undefined,
    OPENCLAW_FACTORY_ACTOR_ID: String(accountId),
    OPENCLAW_FACTORY_SESSION_KEY: sessionKey,
  };
}
