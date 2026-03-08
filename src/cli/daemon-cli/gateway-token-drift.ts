import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayCredentialsFromConfig } from "../../gateway/credentials.js";

export function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    modeOverride: "local",
    // Drift checks should compare the persisted gateway token against the
    // service token, not let an exported shell env mask config drift.
    localTokenPrecedence: "config-first",
  }).token;
}
