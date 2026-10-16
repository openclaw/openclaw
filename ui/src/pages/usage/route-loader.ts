import type { RouteLoaderOptions } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { createDefaultUsageDateRange } from "./helpers.ts";
import { requestUsageSnapshot } from "./request-usage-snapshot.ts";
import type { UsageRouteData } from "./types.ts";

type UsageRouteSnapshot = Pick<UsageRouteData, "gateway" | "gatewaySnapshot"> & {
  agentId: string | null;
  date: Date;
};

function errorMessage(error: unknown): string {
  return isMissingOperatorReadScopeError(error)
    ? formatMissingOperatorReadScopeMessage("usage")
    : formatUiError(error, "request failed");
}

export async function loadUsageRouteData(
  context: Pick<ApplicationContext, "gateway" | "agentSelection">,
  options: RouteLoaderOptions,
  snapshot: UsageRouteSnapshot,
): Promise<UsageRouteData> {
  const { gateway, gatewaySnapshot, agentId, date } = snapshot;
  const query: UsageRouteData["query"] = {
    ...createDefaultUsageDateRange(date),
    scope: "family",
    timeZone: "local",
    agentId,
  };
  const pending: UsageRouteData = {
    gateway,
    gatewaySnapshot,
    query,
    result: null,
    costSummary: null,
    providerUsage: { state: "pending" },
    loadedAtMs: null,
    error: null,
  };
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return pending;
  }
  try {
    // The route captures its owner before import(); never retarget a retired request.
    const current = gateway.snapshot;
    if (
      !options.shouldRun() ||
      current.phase !== "connected" ||
      current.client !== gatewaySnapshot.client ||
      current.hello !== gatewaySnapshot.hello ||
      context.agentSelection.state.scopeId !== query.agentId
    ) {
      return pending;
    }
    const result = await requestUsageSnapshot(
      gatewaySnapshot.client,
      { ...query, agentId: query.agentId ?? undefined },
      options.signal,
    );
    return result.ok
      ? { ...pending, ...result.value, gatewaySnapshot: current, loadedAtMs: Date.now() }
      : {
          ...pending,
          gatewaySnapshot: current,
          providerUsage: result.error.providerUsage,
          error: errorMessage(result.error.cause),
        };
  } catch (error) {
    return { ...pending, error: errorMessage(error) };
  }
}
