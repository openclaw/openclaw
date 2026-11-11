import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isAwaitingGatewayFailure } from "../lib/gateway-availability.ts";

export type PanelRefreshStatus = Readonly<{
  error: string | null;
  hasLoaded: boolean;
  stale: boolean;
  awaitingGateway: boolean;
}>;

export function createPanelRefreshStatus(): PanelRefreshStatus {
  return { error: null, hasLoaded: false, stale: false, awaitingGateway: false };
}

export function beginPanelRefresh(
  status: PanelRefreshStatus,
  options?: { clearError?: boolean },
): PanelRefreshStatus {
  return {
    ...status,
    error: options?.clearError === false ? status.error : null,
  };
}

export function completePanelRefresh(): PanelRefreshStatus {
  return { error: null, hasLoaded: true, stale: false, awaitingGateway: false };
}

export function failPanelRefresh(
  status: PanelRefreshStatus,
  error: unknown,
  gateway: ApplicationGatewaySnapshot | null | undefined,
): PanelRefreshStatus {
  const awaitingGateway = isAwaitingGatewayFailure(error, gateway);
  return {
    error: awaitingGateway ? null : formatUiError(error),
    hasLoaded: status.hasLoaded,
    stale: status.hasLoaded,
    awaitingGateway,
  };
}
