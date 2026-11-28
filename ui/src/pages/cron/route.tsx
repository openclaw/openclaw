import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { readCronInventory } from "../../lib/cron/inventory.ts";
import { buildCronJobsListParams, DEFAULT_CRON_JOBS_FILTERS } from "../../lib/cron/list-params.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";

type CronRouteContext = Pick<ApplicationContext, "gateway"> & {
  agentSelection: Pick<ApplicationContext["agentSelection"], "state">;
};

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context: CronRouteContext, { search }) => search,
  loader: (context: CronRouteContext, { deps, cause, signal, shouldRun }) => {
    const client = context.gateway.snapshot.client;
    const scopeId = context.agentSelection.state.scopeId;
    const canRead = () => {
      const snapshot = context.gateway.snapshot;
      return (
        shouldRun() &&
        !signal.aborted &&
        snapshot.client === client &&
        isGatewayAvailable(snapshot) &&
        hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
        context.agentSelection.state.scopeId === scopeId &&
        globalThis.document?.visibilityState !== "hidden"
      );
    };
    // Full inventory is shared with the mounted page.
    // Filtered/deep-linked routes keep their existing page-owned admission.
    if (cause === "navigation" && !deps && client && canRead()) {
      const params = buildCronJobsListParams(
        { ...DEFAULT_CRON_JOBS_FILTERS, cronAgentId: scopeId },
        { tableFilters: true },
      );
      // The page owns visible errors and retries through this same inventory reader.
      void readCronInventory(client, params, { signal, canRead }).catch(() => {});
    }
    return deps;
  },
  component: () => import("./cron-page.tsx"),
});
