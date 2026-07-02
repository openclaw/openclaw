/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSandboxSessionToolsVisibility,
  resolveSessionToolsVisibility,
  type SessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  listSpawnedSessionKeys,
} from "../../plugin-sdk/session-visibility.js";

export function resolveSandboxSessionToolsVisibilityForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): "spawned" | "all" {
  const normalizedAgentId = normalizeOptionalString(agentId);
  if (normalizedAgentId) {
    const override = cfg.agents?.list?.find(
      (entry) => normalizeAgentId(entry.id) === normalizeAgentId(normalizedAgentId),
    )?.sandbox?.sessionToolsVisibility;
    if (override === "spawned" || override === "all") {
      return override;
    }
  }
  return resolveSandboxSessionToolsVisibility(cfg);
}

export function resolveEffectiveSessionToolsVisibility(params: {
  cfg: OpenClawConfig;
  sandboxed: boolean;
  agentId?: string;
}): SessionToolsVisibility {
  const visibility = resolveSessionToolsVisibility(params.cfg);
  if (!params.sandboxed) {
    return visibility;
  }
  const sandboxClamp = resolveSandboxSessionToolsVisibilityForAgent(params.cfg, params.agentId);
  if (sandboxClamp === "spawned" && visibility !== "tree") {
    return "tree";
  }
  return visibility;
}

function resolveRequesterKeyForAgent(params: {
  requesterInternalKey?: string;
  requesterSessionKey?: string;
  agentId?: string;
  mainKey: string;
  alias: string;
}): string {
  const normalizedAgentId = normalizeOptionalString(params.agentId);
  if (!normalizedAgentId) {
    return params.requesterInternalKey ?? params.alias;
  }
  const parsed = parseAgentSessionKey(params.requesterInternalKey ?? params.requesterSessionKey);
  if (parsed) {
    return `agent:${normalizeAgentId(normalizedAgentId)}:${parsed.rest}`;
  }
  return buildAgentMainSessionKey({
    agentId: normalizedAgentId,
    mainKey: params.mainKey,
  });
}

export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const requesterAgentId =
    normalizeOptionalString(params.agentId) ??
    (requesterInternalKey ? resolveAgentIdFromSessionKey(requesterInternalKey) : undefined);
  const visibility = resolveSandboxSessionToolsVisibilityForAgent(params.cfg, requesterAgentId);
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const effectiveRequesterKey = resolveRequesterKeyForAgent({
    requesterInternalKey,
    requesterSessionKey,
    agentId: explicitAgentId,
    mainKey,
    alias,
  });
  const hasRequesterScope = Boolean(requesterInternalKey) || Boolean(explicitAgentId);
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    hasRequesterScope &&
    !isSubagentSessionKey(effectiveRequesterKey);
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}
