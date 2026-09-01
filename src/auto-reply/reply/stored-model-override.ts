// Normalizes stored reply models and detects stale heartbeat fallback pins.
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection-persisted.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StoredModelOverride } from "../../sessions/stored-model-overrides.js";

/** Resolves CLI-bound provider aliases without rewriting the prepared stored model. */
export function resolveStoredRuntimeModelRef(
  provider: string,
  model: string,
  cfg?: OpenClawConfig,
  sessionEntry?: SessionEntry,
) {
  const hasCliSessionBinding = sessionEntry?.cliSessionBindings?.[provider] !== undefined;
  const canonicalProvider =
    cfg && hasCliSessionBinding
      ? resolveCliRuntimeCanonicalProvider({
          runtime: provider,
          config: cfg,
          includeSetupRegistry: true,
        })
      : undefined;
  return { provider: canonicalProvider ?? provider, model };
}

function resolveModelRefKey(
  params: Parameters<typeof resolvePersistedOverrideModelRef>[0],
): string | null {
  const ref = resolvePersistedOverrideModelRef(params);
  return ref ? buildModelCatalogRef(ref.provider, ref.model) : null;
}

/** Detects heartbeat auto-fallback overrides that no longer match the primary model. */
export function isStaleHeartbeatAutoFallbackOverride(params: {
  isHeartbeat?: boolean;
  hasResolvedHeartbeatModelOverride?: boolean;
  sessionEntry?: SessionEntry;
  storedOverride?: StoredModelOverride | null;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
}): boolean {
  if (params.isHeartbeat !== true || params.hasResolvedHeartbeatModelOverride === true) {
    return false;
  }
  if (params.storedOverride?.source !== "session") {
    return false;
  }
  const entry = params.sessionEntry;
  const recoveredAutoFallbackOverride =
    entry !== undefined &&
    entry.modelOverrideSource === undefined &&
    hasSessionAutoModelFallbackProvenance(entry);
  // Older sessions may lack modelOverrideSource; provenance recovers the auto-fallback state.
  if (entry?.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  if (!entry) {
    return false;
  }

  const primaryKey = resolveModelRefKey({
    routeResolution: "resolved",
    defaultProvider: params.defaultProvider,
    overrideProvider: params.primaryProvider ?? params.defaultProvider,
    overrideModel: params.primaryModel ?? params.defaultModel,
  });
  if (!primaryKey) {
    return false;
  }

  const originKey = resolveModelRefKey({
    routeResolution: "resolved",
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  if (originKey) {
    return originKey !== primaryKey;
  }

  const noticeSelectedKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideModel: normalizeOptionalString(entry.fallbackNotice?.selectedModel),
  });
  if (noticeSelectedKey) {
    return noticeSelectedKey !== primaryKey;
  }

  const storedOverrideKey = resolveModelRefKey({
    routeResolution: "resolved",
    defaultProvider: params.defaultProvider,
    overrideProvider: params.storedOverride.provider,
    overrideModel: params.storedOverride.model,
  });
  return storedOverrideKey !== null && storedOverrideKey !== primaryKey;
}
