// Detects stale heartbeat fallback pins from the identities their producers selected.
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { StoredModelOverride } from "../../sessions/stored-model-overrides.js";

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

  // These are prepared identities, including the encoded notice. Alias expansion or
  // self-provider stripping would conflate distinct models such as custom/custom/model.
  const primaryProvider = params.primaryProvider ?? params.defaultProvider;
  const primaryModel = params.primaryModel ?? params.defaultModel;
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  if (originModel) {
    const originProvider =
      normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) ?? params.defaultProvider;
    return originProvider !== primaryProvider || originModel !== primaryModel;
  }
  const noticeSelectedKey = normalizeOptionalString(entry.fallbackNotice?.selectedModel);
  return noticeSelectedKey
    ? noticeSelectedKey !== buildModelCatalogRef(primaryProvider, primaryModel)
    : (params.storedOverride.provider ?? params.defaultProvider) !== primaryProvider ||
        params.storedOverride.model !== primaryModel;
}
