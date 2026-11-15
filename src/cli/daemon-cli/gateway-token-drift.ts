// Token drift resolver for restart checks: compare service token only when token auth is active.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../../gateway/auth-token-resolution.js";
import { createGatewayCredentialPlan } from "../../gateway/credential-planner.js";
import { GatewaySecretRefUnavailableError } from "../../gateway/credentials.js";

/** Resolve the expected Gateway token for service drift checks, or undefined when token auth is inactive. */
export async function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const mode = params.cfg.gateway?.auth?.mode;
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return undefined;
  }
  const plan = createGatewayCredentialPlan({ config: params.cfg, env });
  if (plan.authMode === undefined && plan.passwordCanWin && !plan.tokenCanWin) {
    return undefined;
  }

  const resolved = await resolveGatewayAuthToken({
    cfg: params.cfg,
    env,
    envFallback: "never",
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.token) {
    return resolved.token;
  }
  if (!resolved.secretRefConfigured) {
    return undefined;
  }
  throw new GatewaySecretRefUnavailableError("gateway.auth.token");
}
