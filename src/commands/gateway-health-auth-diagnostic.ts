/** Gateway health auth diagnostic helpers for reachable-but-unauthenticated probes. */
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";

type GatewayProbeReachabilityEvidence = NonNullable<DaemonStatus["rpc"]>;

export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE =
  "Gateway is reachable, but this CLI has no token/password or paired device token for read-scope health RPCs.";
export const GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE = "Gateway credentials required";
export const GATEWAY_HEALTH_REACHABLE_LINE = "Gateway: reachable";

// Command-neutral variant for non-health Gateway CLI calls (e.g. `gateway usage-cost`,
// `gateway call <method>`). The pre-dispatch credential failure is identical regardless of
// the RPC method, so this states the reachable-but-unauthenticated fact without claiming the
// invoked method is a read-scope health RPC.
export const GATEWAY_REACHABLE_CREDENTIALS_REQUIRED_MESSAGE =
  "Gateway is reachable, but this CLI has no token/password or paired device token to authenticate gateway RPCs. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD.";

/**
 * Detects when a daemon probe reached the gateway even if read-scope auth failed.
 */
export function gatewayProbeResultSawGateway(status: GatewayProbeReachabilityEvidence): boolean {
  if (status.ok) {
    return true;
  }
  const auth = status.auth;
  if (auth?.capability && auth.capability !== "unknown") {
    return true;
  }
  if (auth?.role || (auth?.scopes?.length ?? 0) > 0) {
    return true;
  }
  const server = status.server;
  if (server?.version || server?.connId) {
    return true;
  }
  // Older probes may only expose close/error text for auth failures; treat known gateway
  // close reasons as reachability evidence so health can explain missing credentials.
  return /\bgateway closed \(\d+\):|\bpairing required\b|\bdevice identity required\b/i.test(
    status.error ?? "",
  );
}

/**
 * Builds the diagnostic emitted when the gateway is reachable but credentials are absent.
 *
 * Defaults to the health-specific wording so `gateway health` / doctor behaviour is unchanged.
 * Non-health callers (usage-cost, generic call) pass a command-neutral message so the output
 * never claims the invoked method is a read-scope health RPC.
 */
export function buildCredentialsRequiredHealthDiagnostic(
  message: string = GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
) {
  return {
    ok: false,
    error: {
      type: "gateway_credentials_required",
      message,
    },
    gateway: {
      reachable: true,
    },
  };
}
