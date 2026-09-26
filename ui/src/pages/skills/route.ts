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
  surface: "discovery" | "settings",
): Promise<SkillsRouteData> {
  const search = new URLSearchParams(options.location.search);
  const clawhubRef = search.get("clawhub") ?? undefined;
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const agents = context.agents;
  const selectionOwner =
    surface === "settings" ? context.settingsAgentSelection : context.agentSelection;
  const selection = selectionOwner.state;
  const selectionIntentRevision = selectionOwner.intentRevision;
  const client = gatewaySnapshot.client;
  let error: string | null = null;
  let selectedAgentId: string | null = null;
  let report: SkillsRouteData["report"] = null;
  if (gatewaySnapshot.phase === "connected" && client) {
    try {
      const loadedAgentsList = await agents.ensureList();
      const requestedAgentId =
        search.get("agent") ?? selection.selectedId ?? loadedAgentsList?.defaultId;
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
  }
  return {
    gateway,
    gatewaySnapshot,
    agents,
    selectedAgentId,
    selectionIntentRevision,
    report,
    error,
    clawhubRef,
  };
}

function defineSkillsPage(routeId: "skills" | "skill-settings", surface: "discovery" | "settings") {
  return definePage({
    ...routePageSpec(routeId),
    loaderDeps: (_context: ApplicationContext, location) => location.search,
    loader: (context: ApplicationContext, options) =>
      loadSkillsRouteData(context, options, surface),
    component: () =>
      import("./skills-page.ts").then(() => ({
        header: true,
        render: (data: SkillsRouteData | undefined) =>
          data
            ? html`<openclaw-skills-page
                .routeData=${data}
                .surface=${surface}
              ></openclaw-skills-page>`
            : nothing,
      })),
  });
}

export const pages = [
  defineSkillsPage("skills", "discovery"),
  defineSkillsPage("skill-settings", "settings"),
] as const;
