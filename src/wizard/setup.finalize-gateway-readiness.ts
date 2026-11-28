/**
 * Readiness plan for the Gateway service the setup wizard just prepared.
 * `--skip-health` skips the health RPC, never the readiness of a service this
 * run started: one 1.5 s probe reports a freshly installed Gateway as down.
 */
export type GatewayReadinessPlan = {
  /** This run must wait for reachability before any verdict. */
  awaitReadiness: boolean;
  /** Nothing awaited readiness: the single-probe fallback still governs the verdict. */
  probeOnce: boolean;
  /** Freshly started services get the startup budget instead of the short reuse wait. */
  startupBudget: boolean;
};

export function planGatewayReadiness(
  gateway: { status: string; action?: string },
  skipHealth: boolean | undefined,
  sessionGateway: boolean,
): GatewayReadinessPlan {
  const started = gateway.status === "ready" && gateway.action !== "reused";
  // `--skip-health` is optional, so an omitted flag behaves like `false` here.
  const skipHealthChecks = skipHealth === true;
  return {
    awaitReadiness: !skipHealthChecks || sessionGateway || started,
    probeOnce: skipHealthChecks && !sessionGateway && !started,
    startupBudget: sessionGateway || started,
  };
}
