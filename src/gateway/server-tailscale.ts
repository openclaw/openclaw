import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isTailscaleRouteOwnershipConflictError } from "../infra/tailscale-route-ownership-error.js";
import { TailscaleServeDisabledError } from "../infra/tailscale-serve-disabled-error.js";
import {
  claimTailscaleRoute,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareTailscalePublishedOrigin } from "./tailscale-published-origin.js";

const RECLAIM_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
  signal?: AbortSignal;
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const backendTarget = params.backend.port;
  const effectiveMode = params.tailscaleMode;
  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    if (preservedFunnel) {
      params.logTailscale.warn(
        `external Tailscale Funnel for port ${params.port} remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject its unattributable ingress. ` +
          "First configure a durable gateway password (gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD) and set gateway.auth.mode=password, " +
          "then run `openclaw config set gateway.tailscale.mode funnel` and `openclaw config unset gateway.tailscale.preserveFunnel`; " +
          "see https://docs.openclaw.ai/gateway/tailscale#public-internet-funnel-%2B-shared-password",
      );
      return null;
    }
  }

  const claimRoute = async (signal?: AbortSignal) => {
    let claim: Awaited<ReturnType<typeof claimTailscaleRoute>> | undefined;
    let clearPublishedOrigin: (() => void) | undefined;
    try {
      claim = await claimTailscaleRoute(
        effectiveMode,
        backendTarget,
        params.port,
        params.logTailscale.info,
        signal,
      );
      const hostname = (
        params.tailscaleMode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
      ).catch((error: unknown) => {
        params.logTailscale.warn(
          `Could not read the Tailscale hostname; managed portal ingress is unavailable: ${formatErrorMessage(error)}`,
        );
        return null;
      });
      const host = await racePromiseWithAbortSignal(hostname, signal, (aborted) => aborted.reason);
      signal?.throwIfAborted();
      if (!claim.isActive()) {
        throw new Error(`Managed Tailscale ${params.tailscaleMode} claim exited during startup`);
      }
      const publicHost =
        host &&
        resolveTailscalePublishedHost({
          tailscaleMode: effectiveMode,
          tailnetHost: host,
        });
      if (publicHost) {
        clearPublishedOrigin = prepareTailscalePublishedOrigin({
          origin: `https://${publicHost}`,
          mode: effectiveMode,
        });
      }
      const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
      params.logTailscale.info(
        publicHost
          ? `${effectiveMode} enabled: https://${publicHost}${uiPath} (WS via wss://${publicHost})`
          : `${effectiveMode} enabled`,
      );
      return { claim, clearPublishedOrigin };
    } catch (err) {
      clearPublishedOrigin?.();
      try {
        await claim?.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          "Tailscale exposure startup and cleanup failed",
          { cause: cleanupError },
        );
      }
      signal?.throwIfAborted();
      throw err;
    }
  };

  let route: Awaited<ReturnType<typeof claimRoute>>;
  try {
    route = await claimRoute(params.signal);
  } catch (err) {
    if (params.tailscaleMode === "serve" && err instanceof TailscaleServeDisabledError) {
      params.logTailscale.warn(
        "Tailscale Serve is not enabled on this tailnet. The authenticated local Gateway remains available on loopback; remote access is unavailable. Restore the intended tailnet Serve policy and restart the Gateway.",
      );
      return null;
    }
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
    throw err;
  }

  // Startup retires after handoff; the returned cleanup owns resident recovery.
  const recoveryAbort = new AbortController();
  const recoverySignal = recoveryAbort.signal;
  let recoveryFailure: AggregateError | undefined;
  const recovery = (async () => {
    while (!recoverySignal.aborted) {
      const reason = await racePromiseWithAbortSignal(route.claim.exited, recoverySignal);
      recoverySignal.throwIfAborted();
      route.clearPublishedOrigin?.();
      params.logTailscale.warn(
        `${effectiveMode} route claim exited (${reason}); recovering managed Tailscale ingress`,
      );
      for (let attempt = 1; ; attempt += 1) {
        await sleepWithAbort(computeBackoff(RECLAIM_BACKOFF, attempt), recoverySignal, {
          ref: false,
        });
        try {
          route = await claimRoute(recoverySignal);
          break;
        } catch (error) {
          if (
            recoverySignal.aborted ||
            error instanceof AggregateError ||
            isTailscaleRouteOwnershipConflictError(error)
          ) {
            throw error;
          }
          params.logTailscale.warn(
            `${effectiveMode} recovery failed; retrying: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
  })().catch((error: unknown) => {
    if (error instanceof AggregateError) {
      // Unconfirmed cleanup must remain visible to the shutdown owner.
      recoveryFailure = error;
    }
    if (!recoverySignal.aborted || recoveryFailure) {
      params.logTailscale.warn(`${effectiveMode} recovery stopped: ${formatErrorMessage(error)}`);
    }
  });
  return async () => {
    recoveryAbort.abort();
    route.clearPublishedOrigin?.();
    await recovery;
    route.clearPublishedOrigin?.();
    await route.claim.stop();
    if (recoveryFailure) {
      throw recoveryFailure;
    }
  };
}
