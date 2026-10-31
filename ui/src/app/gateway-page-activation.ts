import { probeGatewayReachability } from "../api/gateway-browser-socket.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Revalidates suspended tabs and lost transports through the application owner. */
export function startGatewayPageActivation(
  gateway: {
    readonly snapshot: Pick<
      ApplicationGatewaySnapshot,
      "phase" | "restartPending" | "suspensionPhase" | "lastErrorCode"
    > & {
      readonly client: Pick<
        GatewayBrowserClient,
        "needsWakeReconnect" | "needsReachabilityReconnect" | "gatewayUrl"
      > | null;
    };
    connect: () => void;
    subscribe: (listener: () => void) => () => void;
  },
  documentTarget: Document,
  windowTarget: Window,
): () => void {
  let disposed = false;
  let queued = false;
  let forceRecovery = false;
  let wasHidden = documentTarget.visibilityState === "hidden";
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | null = null;
  let failedProbes = 0;

  const recoveryAllowed = () => {
    const { phase, restartPending, suspensionPhase } = gateway.snapshot;
    return (
      !disposed &&
      documentTarget.visibilityState === "visible" &&
      !["stopped", "offline", "reload-required", "starting"].includes(phase) &&
      !restartPending &&
      (!suspensionPhase || suspensionPhase === "accepting")
    );
  };
  const shouldProbe = () =>
    recoveryAllowed() &&
    ["connecting", "reconnecting"].includes(gateway.snapshot.phase) &&
    // A failed upgrade's health probe can straddle link restoration and infer
    // busy from the now-live endpoint. Prior unreachable evidence allows one retry.
    (gateway.snapshot.lastErrorCode !== "GATEWAY_BUSY" || failedProbes > 0) &&
    gateway.snapshot.client !== null;
  const clearProbe = () => {
    clearTimeout(probeTimer);
    probeTimer = undefined;
    probe?.abort();
    probe = null;
  };
  // Short interruptions get a fast recovery window. Sustained failures back off
  // to one health check per 4–5 seconds without resetting transport backoff.
  const probeDelay = () =>
    failedProbes < 8
      ? 750 + Math.random() * 250
      : (failedProbes === 8 ? 2_000 : 4_000) + Math.random() * 1_000;
  const syncProbe = (delayMs = probeDelay()) => {
    if (gateway.snapshot.phase === "connected") {
      failedProbes = 0;
    }
    if (!shouldProbe()) {
      clearProbe();
    } else if (probeTimer === undefined && !probe) {
      // Independent tabs and each retry draw a new interval; no shared restore edge.
      probeTimer = setTimeout(() => void checkReachability(), delayMs);
    }
  };
  const checkReachability = async () => {
    probeTimer = undefined;
    const client = gateway.snapshot.client;
    if (!shouldProbe() || !client) {
      return;
    }
    const checkedAtMs = Date.now();
    if (client.needsReachabilityReconnect) {
      const controller = new AbortController();
      probe = controller;
      const timeout = setTimeout(() => controller.abort(), 1_500);
      try {
        const reachable = await probeGatewayReachability(client.gatewayUrl, controller.signal);
        if (!reachable && probe === controller) {
          failedProbes = Math.min(9, failedProbes + 1);
        }
        if (
          reachable &&
          !controller.signal.aborted &&
          shouldProbe() &&
          gateway.snapshot.client === client &&
          client.needsReachabilityReconnect
        ) {
          // The application owner retires the old client and preserves its outbox.
          failedProbes = 0;
          gateway.connect();
        }
      } finally {
        clearTimeout(timeout);
        if (probe === controller) {
          probe = null;
        }
      }
    }
    // Fetch time belongs inside the interval, including an outage's abort timeout.
    syncProbe(Math.max(0, probeDelay() - (Date.now() - checkedAtMs)));
  };

  const schedule = (force: boolean) => {
    if (documentTarget.visibilityState === "hidden") {
      return;
    }
    forceRecovery ||= force;
    if (queued) {
      return;
    }
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const forceQueuedRecovery = forceRecovery;
      forceRecovery = false;
      if (disposed || documentTarget.visibilityState === "hidden") {
        return;
      }
      const { client } = gateway.snapshot;
      failedProbes = 0;
      clearTimeout(probeTimer);
      probeTimer = undefined;
      if (client && recoveryAllowed() && (forceQueuedRecovery || client.needsWakeReconnect)) {
        // Replacing the client retires Safari's ghost socket synchronously. A
        // socket close would depend on the suspended transport firing `close`.
        gateway.connect();
      }
      syncProbe(0);
      void import("./sw-refresh.runtime.ts")
        .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
        .catch((error: unknown) => {
          console.warn("OpenClaw service worker refresh failed after page activation.", error);
        });
    });
  };
  const onVisibilityChange = () => {
    syncProbe();
    if (documentTarget.visibilityState === "hidden") {
      wasHidden = true;
      return;
    }
    if (wasHidden) {
      wasHidden = false;
      schedule(false);
    }
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      schedule(true);
    }
  };
  const onOnline = () => schedule(false);

  const stops = [
    listen(documentTarget, "visibilitychange", onVisibilityChange),
    listen(windowTarget, "pageshow", onPageShow),
    listen(windowTarget, "online", onOnline),
    gateway.subscribe(() => syncProbe()),
  ];
  syncProbe();
  return () => {
    disposed = true;
    clearProbe();
    stops.forEach((stop) => stop());
  };
}
