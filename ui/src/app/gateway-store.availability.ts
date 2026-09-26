// Offline-indicator grace timer and lifecycle-unavailability deadlines, split
// out of gateway-store.ts to keep that module inside the TS LOC ratchet.
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
        host.applySnapshot({ [key]: key === "restartPending" ? false : undefined });
      },
      // Floor 15s: stale lifecycle evidence must degrade to the ordinary offline pill.
      resolveSafeTimeoutDelayMs(expectedMs * 3, { minMs: 15_000 }),
    );
  };
  const scheduleOfflineIndicator = () => {
    const snapshot = host.getSnapshot();
    if (
      host.isStopped() ||
      snapshot.phase === "connected" ||
      snapshot.offlineStable ||
      offlineIndicatorTimer !== null
    ) {
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
