import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayCredentialsFromConfig } from "../../gateway/credentials.js";

export function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: {} as NodeJS.ProcessEnv,
    modeOverride: "local",
    // Drift checks should compare the configured local token source against the
    // persisted service token, not let exported shell env hide stale service state.
    localTokenPrecedence: "config-first",
  }).token;
}
