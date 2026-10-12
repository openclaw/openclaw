import { prepareGitHubReadIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Prepare the protected native identity only for hosts that explicitly opted projects into it. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
}) {
  if (params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  return await prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId: params.agentId,
    env: process.env,
    getCurrentConfig: params.context.getRuntimeConfig,
    assertActive: params.assertActive,
    // A protected identity executable owns token refresh and revalidation.
    refresh: async () => {},
  });
}
