import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  listCoreToolSections,
  PROFILE_OPTIONS,
  resolveCoreToolProfiles,
} from "../../agents/tool-catalog.js";
import { loadConfig } from "../../config/config.js";
import { getPluginToolMeta, resolvePluginTools } from "../../plugins/tools.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsCatalogParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type ToolCatalogEntry = {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
  defaultProfiles: Array<"minimal" | "coding" | "messaging" | "full">;
};

type ToolCatalogGroup = {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolCatalogEntry[];
};

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId };
}

function buildCoreGroups(): ToolCatalogGroup[] {
  return listCoreToolSections().map((section) => ({
    id: section.id,
    label: section.label,
    source: "core",
    tools: section.tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
      source: "core",
      defaultProfiles: resolveCoreToolProfiles(tool.id),
    })),
  }));
}

function buildPluginGroups(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  existingToolNames: Set<string>;
}): ToolCatalogGroup[] {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const pluginTools = resolvePluginTools({
    context: {
      config: params.cfg,
      workspaceDir,
      agentDir,
      agentId: params.agentId,
    },
    existingToolNames: params.existingToolNames,
    toolAllowlist: ["group:plugins"],
    suppressNameConflicts: true,
  });
  const groups = new Map<string, ToolCatalogGroup>();
  for (const tool of pluginTools) {
    const meta = getPluginToolMeta(tool);
    const pluginId = meta?.pluginId ?? "plugin";
    const groupId = `plugin:${pluginId}`;
    const existing =
      groups.get(groupId) ??
      ({
        id: groupId,
        label: pluginId,
        source: "plugin",
        pluginId,
        tools: [],
      } as ToolCatalogGroup);
    existing.tools.push({
      id: tool.name,
      label: typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : tool.name,
      description:
        typeof tool.description === "string" && tool.description.trim()
          ? tool.description.trim()
          : "Plugin tool",
      source: "plugin",
      pluginId,
      optional: meta?.optional,
      defaultProfiles: [],
    });
    groups.set(groupId, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export const toolsCatalogHandlers: GatewayRequestHandlers = {
  "tools.catalog": ({ params, respond }) => {
    if (!validateToolsCatalogParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    const includePlugins = params.includePlugins !== false;
    const groups = buildCoreGroups();
    if (includePlugins) {
      const existingToolNames = new Set(
        groups.flatMap((group) => group.tools.map((tool) => tool.id)),
      );
      groups.push(
        ...buildPluginGroups({
          cfg: resolved.cfg,
          agentId: resolved.agentId,
          existingToolNames,
        }),
      );
    }
    respond(
      true,
      {
        agentId: resolved.agentId,
        profiles: PROFILE_OPTIONS.map((profile) => ({ id: profile.id, label: profile.label })),
        groups,
      },
      undefined,
    );
  },
};
