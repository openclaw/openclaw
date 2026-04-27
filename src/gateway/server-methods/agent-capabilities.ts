import {
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { listConfiguredBindings } from "../../config/bindings.js";
import { loadConfig } from "../../config/config.js";
import { normalizeConfiguredMcpServers } from "../../config/mcp-config.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { loadCombinedSessionStoreForGateway } from "../../config/sessions.js";
import { parseAgentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentCapabilitiesParams,
} from "../protocol/index.js";
import { buildToolsCatalogResult } from "./tools-catalog.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = normalizeOptionalString(rawAgentId) ?? "";
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

export const agentCapabilitiesHandlers: GatewayRequestHandlers = {
  "agent.capabilities": ({ params, respond }) => {
    if (!validateAgentCapabilitiesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.capabilities params: ${formatValidationErrors(validateAgentCapabilitiesParams.errors)}`,
        ),
      );
      return;
    }

    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    const { cfg, agentId } = resolved;

    // Model
    const primary = resolveAgentEffectiveModelPrimary(cfg, agentId);
    const agentFallbacksOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
    const fallbacks =
      agentFallbacksOverride ?? resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);

    // Tools
    const catalogResult = buildToolsCatalogResult({ cfg, agentId, includePlugins: true });
    let coreCount = 0;
    let pluginCount = 0;
    for (const group of catalogResult.groups) {
      if (group.source === "core") {
        coreCount += group.tools.length;
      } else {
        pluginCount += group.tools.length;
      }
    }

    // MCP servers
    const mcpServers = Object.keys(normalizeConfiguredMcpServers(cfg.mcp?.servers));

    // Skills
    const agentEntry = resolveAgentConfig(cfg, agentId);
    const rawSkills =
      agentEntry && Object.hasOwn(agentEntry, "skills")
        ? agentEntry.skills
        : cfg.agents?.defaults?.skills;
    const skills: string[] = Array.isArray(rawSkills) ? rawSkills : [];

    // Channels: collect channel IDs from bindings that target this agent
    const normalizedAgentId = normalizeAgentId(agentId);
    const bindings = listConfiguredBindings(cfg);
    const channelSet = new Set<string>();
    for (const binding of bindings) {
      if (normalizeAgentId(binding.agentId) === normalizedAgentId) {
        const channelId = normalizeOptionalString(binding.match.channel);
        if (channelId) {
          channelSet.add(channelId);
        }
      }
    }
    const channels = [...channelSet].sort();

    // Session count: count sessions whose key parses to this agent
    const { store } = loadCombinedSessionStoreForGateway(cfg);
    let sessionCount = 0;
    for (const key of Object.keys(store)) {
      const parsed = parseAgentSessionKey(key);
      if (parsed && normalizeAgentId(parsed.agentId) === normalizedAgentId) {
        sessionCount += 1;
      }
    }

    // Name
    const name = normalizeOptionalString(agentEntry?.name) ?? undefined;

    respond(
      true,
      {
        agentId,
        ...(name ? { name } : {}),
        model: {
          ...(primary ? { primary } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        },
        tools: {
          count: coreCount + pluginCount,
          sources: { core: coreCount, plugin: pluginCount },
        },
        mcpServers,
        skills,
        channels,
        sessionCount,
      },
      undefined,
    );
  },
};
