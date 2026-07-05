// Gateway probe auth helpers used by status scans.
// This module resolves probe credentials without exposing secret values to report builders.

import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeTarget,
} from "../gateway/probe-auth.js";
<<<<<<< HEAD
=======
export { pickGatewaySelfPresence } from "./gateway-presence.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Resolves gateway probe auth plus any non-secret warning about credential lookup. */
export async function resolveGatewayProbeAuthResolution(cfg: OpenClawConfig): Promise<{
  auth: {
    token?: string;
    password?: string;
  };
  warning?: string;
}> {
  const target = resolveGatewayProbeTarget(cfg);
  // Probe auth resolution depends on local/remote mode because token/password sources differ.
  return resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg,
    mode: target.mode,
    env: process.env,
  });
}
<<<<<<< HEAD
=======

/** Resolves only gateway probe auth material for callers that do not display warnings. */
export async function resolveGatewayProbeAuth(cfg: OpenClawConfig): Promise<{
  token?: string;
  password?: string;
}> {
  return (await resolveGatewayProbeAuthResolution(cfg)).auth;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
