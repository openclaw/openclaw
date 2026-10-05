import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import {
  factoryGitHubClientProof,
  readFactoryGitHubToken,
  type FactoryGitHubProofClaim,
} from "./factory-github-proof.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Prepare the protected native identity only for hosts that explicitly opted projects into it. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client?: GatewayClient | null;
  sessionKey?: string;
  factoryCredential?: { claim: FactoryGitHubProofClaim; assertCurrent: () => void };
}) {
  const managed = (["agent", "system"] as const).some((scope) =>
    resolveConfiguredGitHubToolIdentity({ config: params.config, agentId: params.agentId, scope }),
  );
  if (!managed && params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  const purpose =
    params.factoryCredential?.claim.purpose === "session-item-read"
      ? "session-item-read"
      : undefined;
  const factoryEnv = factoryGitHubActorEnvironment(params.client, params.sessionKey ?? "", purpose);
  const profileId = params.client?.authenticatedUserProfile?.profileId;
  const assertActive = () => {
    params.assertActive();
    params.factoryCredential?.assertCurrent();
    if (
      factoryEnv &&
      (factoryGitHubActorEnvironment(params.client, params.sessionKey ?? "", purpose)
        ?.OPENCLAW_FACTORY_ACTOR_ID !== factoryEnv.OPENCLAW_FACTORY_ACTOR_ID ||
        params.client?.authenticatedUserProfile?.profileId !== profileId)
    ) {
      throw new Error("Factory project requester changed during preparation");
    }
  };
  if (factoryEnv && !params.factoryCredential) {
    throw new Error("Factory GitHub repository access requires current caller authority.");
  }
  const credential = factoryEnv ? params.factoryCredential : undefined;
  const identity = await prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId: params.agentId,
    env: factoryEnv ?? process.env,
    readNativeCredential: credential
      ? (currentEnv, admission) =>
          readFactoryGitHubToken(
            currentEnv,
            factoryGitHubClientProof({
              client: params.client,
              claim: credential.claim,
              assertCurrent: assertActive,
            }),
            admission,
          )
      : undefined,
    getCurrentConfig: params.context.getRuntimeConfig,
    assertActive,
    refresh: () => requestCurrentGitHubOAuthRefresh(params.agentId),
  });
  assertActive();
  return identity;
}

/** Project picker/clone have no session agent; use only an unambiguous configured owner. */
export async function prepareConfiguredProjectGitHubIdentity(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader;
}) {
  const agentId = tryResolveAmbientOwnerAgentId(params.config) ?? "";
  if (
    !(["agent", "system"] as const).some((scope) =>
      resolveConfiguredGitHubToolIdentity({ config: params.config, agentId, scope }),
    )
  ) {
    return undefined;
  }
  return prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId,
    readNativeCredential: params.readNativeCredential,
    getCurrentConfig: params.getCurrentConfig,
    assertActive: params.assertCurrent,
    refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
  });
}
