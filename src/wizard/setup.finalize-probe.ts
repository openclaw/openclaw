import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { probeGatewayReachable, waitForGatewayReachable } from "../commands/onboard-helpers.js";

export async function probeFinalizeGateway(params: {
  sessionGateway: { wait: Promise<unknown> } | undefined;
  gateway: { status: string; action?: string };
  url: string;
  token: string | undefined;
  password: string | undefined;
  signal: AbortSignal;
}) {
  const probeOptions = {
    signal: params.signal,
    url: params.url,
    token: params.token,
    password: params.password,
  };
  // Nothing started (declined or failed install): probe once. A reused running
  // Gateway keeps a bounded wait because the config just written can make it
  // reload; started Gateways use the full startup timing.
  const readiness =
    params.gateway.status === "failed" ||
    (params.gateway.status === "skipped" && !params.sessionGateway)
      ? probeGatewayReachable(probeOptions)
      : waitForGatewayReachable({
          ...probeOptions,
          ...(params.sessionGateway ||
          (params.gateway.status === "ready" && params.gateway.action !== "reused")
            ? resolveGatewayStartupTiming()
            : { deadlineMs: 15_000 }),
        });
  return await (params.sessionGateway
    ? Promise.race([
        readiness,
        params.sessionGateway.wait.then(() => {
          throw new Error("Temporary Gateway exited before becoming reachable");
        }),
      ])
    : readiness);
}
