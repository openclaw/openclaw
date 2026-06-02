import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";

function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean {
  return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}

/** Decide whether a Gateway call can use explicit URL/auth without loading config. */
export function canSkipGatewayConfigLoad(params: {
  /** Already-loaded config; when present, callers should use normal config resolution. */
  config?: OpenClawConfig;
  /** Explicit Gateway URL supplied by CLI/env. */
  urlOverride?: string;
  /** Explicit token/password supplied alongside the URL override. */
  explicitAuth?: ExplicitGatewayAuth;
}): boolean {
  return (
    !params.config &&
    Boolean(trimToUndefined(params.urlOverride)) &&
    hasExplicitGatewayConnectionAuth(params.explicitAuth)
  );
}

/** Command paths allowed to bypass config guard because Gateway owns their config needs. */
export function isGatewayConfigBypassCommandPath(commandPath: readonly string[]): boolean {
  return commandPath[0] === "cron";
}
