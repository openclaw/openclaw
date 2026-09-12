// Resolves the utility model used for short internal tasks (titles, progress
// narration). Unset config derives the provider-declared small model from the
// agent's primary provider; an explicit empty string disables utility routing.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

type UtilityModelSetting =
  | { kind: "explicit"; modelRef: string }
  | { kind: "disabled" }
  | { kind: "auto" };

/**
 * Reads the configured utility-model setting. A defined-but-empty value is an
 * explicit opt-out ("disabled"), distinct from unset ("auto"); the agent-level
 * value wins over defaults even when it is the empty string.
 */
export function readUtilityModelSetting(cfg: OpenClawConfig, agentId: string): UtilityModelSetting {
  const value =
    resolveAgentConfig(cfg, agentId)?.utilityModel ?? cfg.agents?.defaults?.utilityModel;
  if (value === undefined) {
    return { kind: "auto" };
  }
  const trimmed = value.trim();
  return trimmed ? { kind: "explicit", modelRef: trimmed } : { kind: "disabled" };
}

/**
 * Automatic utility model for an already-resolved primary provider (manifest
 * `modelCatalog.providers.<id>.defaultUtilityModel`), or undefined when the
 * provider does not declare one. Reads only the process-current plugin
 * metadata snapshot, so the lookup stays synchronous and cheap; contexts
 * without a snapshot simply get no derived default.
 */
export function resolveAutomaticUtilityModelRef(params: {
  cfg: OpenClawConfig;
  primaryProvider: string;
  primaryModelRef?: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): string | undefined {
  const provider = params.primaryProvider.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }
  const snapshot =
    params.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  if (!snapshot) {
    return undefined;
  }
  for (const plugin of snapshot.plugins) {
    const defaultUtilityModel = plugin.modelCatalog?.providers?.[provider]?.defaultUtilityModel;
    const modelId = defaultUtilityModel?.trim();
    if (modelId) {
      const derived = `${provider}/${modelId}`;
      // Automatic routing stays with the primary model's explicit auth owner.
      const profile = params.primaryModelRef
        ? splitTrailingAuthProfile(params.primaryModelRef).profile
        : undefined;
      return profile ? `${derived}@${profile}` : derived;
    }
  }
  return undefined;
}

/**
 * The utility model ref to use for the agent, or undefined when utility
 * routing is disabled or no default exists. Callers with a session-specific
 * selection pass both primary fields so automatic routing keeps that session's
 * provider and auth owner.
 */
export function resolveUtilityModelRefForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Pass when the caller already resolved the primary provider. */
  primaryProvider?: string;
  /** Pass with primaryProvider to carry a session-specific auth profile. */
  primaryModelRef?: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): string | undefined {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  if (setting.kind === "explicit") {
    return setting.modelRef;
  }
  if (setting.kind === "disabled") {
    return undefined;
  }
  const provider =
    params.primaryProvider?.trim() ||
    resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId }).provider;
  return resolveAutomaticUtilityModelRef({
    cfg: params.cfg,
    primaryProvider: provider,
    primaryModelRef:
      params.primaryModelRef?.trim() ||
      resolveAgentEffectiveModelPrimary(params.cfg, params.agentId),
    metadataSnapshot: params.metadataSnapshot,
  });
}
