import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";
import type { SkillsRouteData } from "./view-types.ts";

function defineSkillsPage(routeId: "skills" | "skill-settings", surface: "discovery" | "settings") {
  return definePage({
    ...routePageSpec(routeId),
    loaderDeps: (_context: ApplicationContext, location) => location.search,
    loader: async (
      context: ApplicationContext,
      options: RouteLoaderOptions,
    ): Promise<SkillsRouteData> => {
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
      }
      // Metadata-only snapshots preserve the transport while inventory overlaps lazy page code.
      const current = gateway.snapshot;
      const statusRead =
        client &&
        selectedAgentId &&
        options.shouldRun() &&
        current.phase === "connected" &&
        current.client === client &&
        current.hello === gatewaySnapshot.hello &&
        hasOperatorReadAccess(current.hello?.auth ?? null) &&
        selectionOwner.intentRevision === selectionIntentRevision
          ? loadSkillStatusReport(client, selectedAgentId).then(
              (report) => ({ ok: true as const, report }),
              (error: unknown) => ({ ok: false as const, error }),
            )
          : null;
      return {
        gateway,
        gatewaySnapshot,
        agents,
        selectedAgentId,
        selectionIntentRevision,
        statusRead,
        error,
        clawhubRef,
      };
    },
    component: () =>
      import("./skills-page.tsx").then((module) => ({
        renderSolid: module.createSkillsRenderer(surface),
      })),
  });
}

export const pages = [
  defineSkillsPage("skills", "discovery"),
  defineSkillsPage("skill-settings", "settings"),
] as const;
