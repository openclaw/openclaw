import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadAgentsList } from "../../lib/agents/index.ts";
import { loadSkillStatusReport } from "../../lib/skills/index.ts";
import type { SkillsRouteData } from "./skills-page.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSkillsRouteData(context: ApplicationContext<RouteId>): Promise<SkillsRouteData> {
  const gateway = context.gateway.snapshot;
  const client = gateway.client;
  if (!gateway.connected || !client) {
    return {
      connected: false,
      agentsList: null,
      selectedAgentId: null,
      report: null,
      error: null,
    };
  }

  let error: string | null = null;
  let agentsList: SkillsRouteData["agentsList"] = null;
  let report: SkillsRouteData["report"] = null;
  try {
    agentsList = await loadAgentsList(client);
  } catch (err) {
    error = errorMessage(err);
  }
  try {
    report = (await loadSkillStatusReport(client, null)) ?? null;
  } catch (err) {
    error ??= errorMessage(err);
  }
  return {
    connected: true,
    agentsList,
    selectedAgentId: null,
    report,
    error,
  };
}

export const page = definePage({
  id: "skills",
  path: "/skills",
  loader: loadSkillsRouteData,
  component: () =>
    import("./skills-page.ts").then(() => ({
      header: true,
      render: (data) => html`<openclaw-skills-page .routeData=${data}></openclaw-skills-page>`,
    })),
});
