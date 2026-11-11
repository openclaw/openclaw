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
  const profile = declaration(plan.manifestDisclosure?.openClawProfileJson);
  const agent = isRecord(manifest.agent) ? manifest.agent : {};
  const profileAgent = isRecord(profile.agent) ? profile.agent : {};
  const tools = isRecord(profileAgent.tools) ? profileAgent.tools : {};
  const fs = isRecord(tools.fs) ? tools.fs : {};
  const requestedTools = [tools.allow, tools.alsoAllow].flatMap((value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
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
      ? [{ id: action.id, action: action.action, ...action.effect.proposed }]
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
    requestedTools,
    toolProfile: typeof tools.profile === "string" ? tools.profile : undefined,
    workspaceOnly: fs.workspaceOnly === true,
    requestsExec: requestedTools.includes("exec") || requestedTools.includes("group:runtime"),
  };
}

export function structuredTemplateFields(value: unknown, prefix = ""): Array<[string, string]> {
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      structuredTemplateFields(child, prefix ? prefix + "." + key : key),
    );
  }
  if (Array.isArray(value)) {
    return [
      [
        prefix,
        value.length
          ? value
              .map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
              .join(" · ")
          : "—",
      ],
    ];
  }
  return [[prefix, typeof value === "string" ? value : (JSON.stringify(value) ?? "—")]];
}
