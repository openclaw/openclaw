import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";

function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean {
  return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}

/** Returns true only when a direct Gateway URL has enough inline auth to avoid reading config. */
export function canSkipGatewayConfigLoad(params: {
  config?: OpenClawConfig;
  urlOverride?: string;
  explicitAuth?: ExplicitGatewayAuth;
}): boolean {
  return (
    !params.config &&
    Boolean(trimToUndefined(params.urlOverride)) &&
    hasExplicitGatewayConnectionAuth(params.explicitAuth)
  );
}

/** Identifies CLI command paths whose Gateway calls must work before config is readable. */
export function isGatewayConfigBypassCommandPath(commandPath: readonly string[]): boolean {
  // Cron can run from unattended schedulers, so explicit connection flags/env are allowed
  // to bypass the startup config guard before the normal config path is available.
  return commandPath[0] === "cron";
}
