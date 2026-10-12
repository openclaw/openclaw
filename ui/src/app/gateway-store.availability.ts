import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import type { ApplicationGatewaySnapshot } from "./context.ts";

// Grace window before offline presentation appears; reconnects never wait.
const OFFLINE_INDICATOR_DELAY_MS = 2_000;

type UnavailableDeadlineKey = "restartPending" | "suspensionPhase";

type AvailabilityHost = {
  isStopped: () => boolean;
  getSnapshot: () => ApplicationGatewaySnapshot;
  applySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

export function createAvailabilityIndicators(host: AvailabilityHost) {
  let offlineIndicatorTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const unavailableDeadlines: Partial<
    Record<UnavailableDeadlineKey, ReturnType<typeof globalThis.setTimeout>>
  > = {};
  const clearOfflineIndicatorTimer = () => {
    globalThis.clearTimeout(offlineIndicatorTimer ?? undefined);
    offlineIndicatorTimer = null;
  };
  const setUnavailableDeadline = (key: UnavailableDeadlineKey, expectedMs?: number) => {
    globalThis.clearTimeout(unavailableDeadlines[key]);
    delete unavailableDeadlines[key];
    if (expectedMs === undefined) {
      return;
    }
    unavailableDeadlines[key] = globalThis.setTimeout(
      () => {
        delete unavailableDeadlines[key];
        if (key !== "restartPending" || host.getSnapshot().phase !== "connected") {
          host.applySnapshot({ [key]: key === "restartPending" ? false : undefined });
        }
      },
      // Offline evidence expires after at least 15s; connected drains wait for close or hello.
      resolveSafeTimeoutDelayMs(expectedMs * 3, { minMs: 15_000 }),
    );
  };
  const scheduleOfflineIndicator = () => {
    const snapshot = host.getSnapshot();
    if (host.isStopped() || snapshot.phase === "connected") {
      return;
    }
    if (snapshot.restartPending && unavailableDeadlines.restartPending === undefined) {
      setUnavailableDeadline("restartPending", 0);
    }
    if (snapshot.offlineStable || offlineIndicatorTimer !== null) {
      return;
    }
    offlineIndicatorTimer = globalThis.setTimeout(() => {
      offlineIndicatorTimer = null;
      if (!host.isStopped() && host.getSnapshot().phase !== "connected") {
        host.applySnapshot({ offlineStable: true });
      }
    }, OFFLINE_INDICATOR_DELAY_MS);
  };
  return {
    clearOfflineIndicatorTimer,
    setUnavailableDeadline,
    scheduleOfflineIndicator,
    hasSuspensionDeadline: () => unavailableDeadlines.suspensionPhase !== undefined,
  };
}
