import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadAgentsList } from "../../lib/agents/index.ts";
import { createInitialCronState, loadCronJobsPage, loadCronStatus } from "../../lib/cron/index.ts";
import type { CronRouteData } from "./cron-page.ts";

async function loadCronRouteData(context: ApplicationContext<RouteId>): Promise<CronRouteData> {
  const gateway = context.gateway.snapshot;
  const cron = createInitialCronState({
    client: gateway.client,
    connected: gateway.connected,
  });
  if (!gateway.connected || !gateway.client) {
    return { connected: false, cron, agentsList: null };
  }
  let agentsList: CronRouteData["agentsList"] = null;
  await Promise.all([
    context.channels.refresh(false),
    loadAgentsList(gateway.client).then(
      (result) => {
        agentsList = result;
      },
      () => undefined,
    ),
    loadCronStatus(cron),
    loadCronJobsPage(cron, { tableFilters: true }),
  ]);
  return { connected: true, cron, agentsList };
}

export const page = definePage({
  id: "cron",
  path: "/cron",
  loader: loadCronRouteData,
  component: () =>
    import("./cron-page.ts").then(() => ({
      header: true,
      render: (data) => html`<openclaw-cron-page .routeData=${data}></openclaw-cron-page>`,
    })),
});
