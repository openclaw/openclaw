import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";
import type { SkillsRouteData } from "./skills-page.ts";

async function loadSkillsRouteData(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<SkillsRouteData> {
  const search = new URLSearchParams(options.location.search);
  const clawhubRef = search.get("clawhub") ?? undefined;
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const agents = context.agents;
  const client = gatewaySnapshot.client;
  if (gatewaySnapshot.phase !== "connected" || !client) {
    return {
      gateway,
      gatewaySnapshot,
      agents,
      agentsList: null,
      selectedAgentId: null,
      report: null,
      error: null,
      clawhubRef,
    };
  }

  let error: string | null = null;
  let agentsList: SkillsRouteData["agentsList"] = null;
  let selectedAgentId: string | null = null;
  let report: SkillsRouteData["report"] = null;
  try {
    const loadedAgentsList = await agents.ensureList();
    agentsList = loadedAgentsList;
    const requestedAgentId = search.get("agent") ?? loadedAgentsList?.defaultId;
    selectedAgentId = loadedAgentsList?.agents.some((agent) => agent.id === requestedAgentId)
      ? (requestedAgentId ?? null)
      : null;
  } catch (err) {
    error = formatUiError(err);
  }
  if (selectedAgentId) {
    try {
      report = (await loadSkillStatusReport(client, selectedAgentId)) ?? null;
    } catch (err) {
      error ??= formatUiError(err);
    }
  }
  return {
    gateway,
    gatewaySnapshot,
    agents,
    agentsList,
    selectedAgentId,
    report,
    error,
    clawhubRef,
  };
}

export const page = definePage({
  ...routePageSpec("skills"),
  loaderDeps: (_context: ApplicationContext, location) => location.search,
  loader: loadSkillsRouteData,
  component: () =>
    import("./skills-page.ts").then(() => ({
      header: true,
      render: (data: SkillsRouteData | undefined) =>
        data ? html`<openclaw-skills-page .routeData=${data}></openclaw-skills-page>` : nothing,
    })),
});
