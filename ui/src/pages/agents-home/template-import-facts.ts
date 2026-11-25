import { isRecord } from "@openclaw/normalization-core";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

// These are package declarations from the Gateway, not effective permission decisions.
function declaration(json: string | undefined): Record<string, unknown> {
  if (!json) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function templateImportFacts(plan: TemplateAddReviewPlan) {
  const manifest = declaration(plan.manifestDisclosure?.manifestJson);
  const agent = isRecord(manifest.agent) ? manifest.agent : {};
  const files = plan.actions.filter((action) => action.effect?.type === "workspace-file");
  const skills = plan.actions.flatMap((action) =>
    action.effect?.type === "skill-package" && action.effect.desired
      ? [{ ...action.effect.desired, action: action.action }]
      : [],
  );
  const fileNames = files
    .map((file) => file.id)
    .toSorted((a, b) => {
      const rank = (name: string) => (name === "SOUL.md" ? 0 : name === "AGENTS.md" ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  const automations = Array.isArray(manifest.automations) ? manifest.automations : [];
  const mcpServers = plan.actions.flatMap((action) =>
    action.effect?.type === "mcp-server"
      ? [{ id: action.id, proposed: action.effect.proposed }]
      : [],
  );
  const schedules = (plan.scheduledJobs?.jobs ?? []).map((job) => {
    const declared = automations.find((item) => isRecord(item) && item.id === job.id);
    const name = isRecord(declared) && typeof declared.name === "string" ? declared.name : job.id;
    return Object.assign({}, job, { name });
  });
  return {
    name:
      typeof agent.name === "string"
        ? agent.name
        : (plan.target.name ?? plan.target.agentId ?? "Template"),
    description: typeof agent.description === "string" ? agent.description : "",
    files,
    fileNames,
    skills,
    schedules,
    mcpServers,
  };
}
