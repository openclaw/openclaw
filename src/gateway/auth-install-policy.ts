// Gateway install auth policy used by service/install flows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

/** Decide whether install should require token auth when no durable password source exists. */
export function shouldRequireGatewayTokenForInstall(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  switch (cfg.gateway?.auth?.mode) {
    case "token":
      return true;
    case "password":
    case "none":
    case "trusted-proxy":
      return false;
    case undefined:
      break;
  }

  if (hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults)) {
    return false;
  }

  // Service install should only infer password mode from durable sources that
  // survive outside the invoking shell.
  const durableServiceEnv = collectDurableServiceEnvVars({ env, config: cfg });
  return !(
    normalizeOptionalString(durableServiceEnv.OPENCLAW_GATEWAY_PASSWORD) ||
    normalizeOptionalString(durableServiceEnv.CLAWDBOT_GATEWAY_PASSWORD)
  );
}
