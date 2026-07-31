import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { listAgentIds, tryResolveSoleAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();
const legacyOwnershipWarningsByConfig = new WeakMap<object, LegacyAgentOwnershipWarning[]>();

type LegacyAgentOwnershipWarning = {
  path: string;
  message: string;
};

/** Retains the retired marker's owner only for the in-process upgrade migration window. */
export function retainLegacyDefaultAgentId(
  config: OpenClawConfig,
  agentId: string | undefined,
  options: {
    warnings?: readonly LegacyAgentOwnershipWarning[];
  } = {},
): OpenClawConfig {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, normalizeAgentId(agentId));
  } else {
    legacyDefaultAgentIdByConfig.delete(config);
  }
  if (agentId && options.warnings && options.warnings.length > 0) {
    legacyOwnershipWarningsByConfig.set(config, [...options.warnings]);
  } else {
    legacyOwnershipWarningsByConfig.delete(config);
  }
  return config;
}

/** Carries upgrade-only ownership metadata across runtime config materialization. */
export function inheritLegacyDefaultAgentId(
  source: OpenClawConfig,
  target: OpenClawConfig,
): OpenClawConfig {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source), {
    warnings: legacyOwnershipWarningsByConfig.get(source),
  });
}

/** Reads the retired owner without restoring it to the public config shape. */
export function tryGetLegacyDefaultAgentId(config: OpenClawConfig): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}

/** Resolves the live compatibility owner without routing to a departed retained agent. */
export function tryResolveLegacyCompatibilityAgentId(config: OpenClawConfig): string | undefined {
  const retainedAgentId = tryGetLegacyDefaultAgentId(config);
  if (
    retainedAgentId &&
    listAgentIds(config).some((agentId) => normalizeAgentId(agentId) === retainedAgentId)
  ) {
    return retainedAgentId;
  }
  // Raw default:true markers are migration input, never a runtime fallback. The loader
  // retains their owner above; without that sidecar only a live sole agent is compatible.
  return tryResolveSoleAgentId(config);
}

/** Resolves the physical owner of unscoped fixed-store rows without inventing one for explicit fleets. */
export function tryResolveSessionStoreCompatibilityAgentId(
  config: OpenClawConfig,
): string | undefined {
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  if (persistedAgentId) {
    return normalizeAgentId(persistedAgentId);
  }
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(config);
  if (compatibilityAgentId || config.agents?.ownership === "explicit") {
    return compatibilityAgentId;
  }
  return "main";
}

/** Resolves the physical owner where the shipped legacy-main fallback remains required. */
export function resolveSessionStoreCompatibilityAgentId(config: OpenClawConfig): string {
  return tryResolveSessionStoreCompatibilityAgentId(config) ?? "main";
}

/** Adds per-surface warnings while a legacy first-entry owner is retained. */
export function appendLegacyOwnershipWarnings(
  config: OpenClawConfig,
  warnings: readonly LegacyAgentOwnershipWarning[],
): void {
  if (!legacyDefaultAgentIdByConfig.has(config) || warnings.length === 0) {
    return;
  }
  legacyOwnershipWarningsByConfig.set(config, [
    ...(legacyOwnershipWarningsByConfig.get(config) ?? []),
    ...warnings,
  ]);
}

export function listLegacyOwnershipWarnings(config: OpenClawConfig): LegacyAgentOwnershipWarning[] {
  return [...(legacyOwnershipWarningsByConfig.get(config) ?? [])];
}
