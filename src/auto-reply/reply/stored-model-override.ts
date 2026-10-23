// Resolves stored model pins and their fallback probes against the current turn.
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  resolveStoredModelOverrideAsync,
  type StoredModelOverride,
} from "../../sessions/stored-model-overrides.js";

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
  if (!entry) {
    return false;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  // Older sessions may lack modelOverrideSource; provenance recovers the auto-fallback state.
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
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

/** Keep stored-pin selection and primary probing under the same turn-local precedence. */
export async function resolveReplyStoredModelSelection(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  parentSessionKey?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider: string;
  primaryModel: string;
  sessionModelSelectionLocked: boolean;
  hasResolvedTurnModelOverride: boolean;
  isHeartbeat?: boolean;
}) {
  const { sessionEntry, sessionModelSelectionLocked, hasResolvedTurnModelOverride } = params;
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  const storedOverride = await resolveStoredModelOverrideAsync(params);
  const staleHeartbeatAutoFallbackOverride =
    !sessionModelSelectionLocked &&
    isStaleHeartbeatAutoFallbackOverride({
      ...params,
      hasResolvedHeartbeatModelOverride:
        params.isHeartbeat === true && hasResolvedTurnModelOverride,
      storedOverride,
    });
  const staleLegacyAutoFallbackWithoutOrigin =
    !sessionModelSelectionLocked &&
    storedOverride?.source === "session" &&
    hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  const modelOverride =
    storedOverride?.model &&
    !hasResolvedTurnModelOverride &&
    !staleHeartbeatAutoFallbackOverride &&
    !staleLegacyAutoFallbackWithoutOrigin
      ? {
          provider: storedOverride.provider ?? params.defaultProvider,
          model: storedOverride.model,
        }
      : undefined;
  const autoFallbackPrimaryProbe =
    !sessionModelSelectionLocked &&
    !hasResolvedTurnModelOverride &&
    !staleHeartbeatAutoFallbackOverride
      ? resolveAutoFallbackPrimaryProbe({
          entry: sessionEntry,
          sessionKey: params.sessionKey,
          primaryProvider: params.primaryProvider,
          primaryModel: params.primaryModel,
        })
      : undefined;
  return {
    modelOverride,
    autoFallbackPrimaryProbe,
    hasEffectiveStoredModelOverride:
      Boolean(storedOverride || hasSessionModelOverride) &&
      !staleHeartbeatAutoFallbackOverride &&
      !staleLegacyAutoFallbackWithoutOrigin,
  };
}
