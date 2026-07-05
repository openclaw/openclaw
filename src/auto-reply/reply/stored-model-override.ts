// Persists and resolves per-session model override choices.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import {
  modelKey,
  normalizeModelRef,
<<<<<<< HEAD
  normalizeStoredOverrideModel,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import type { SessionEntry } from "../../config/sessions/types.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
};

function resolveParentSessionKeyCandidate(params: {
  sessionKey?: string;
  parentSessionKey?: string;
}): string | null {
  const explicit = normalizeOptionalString(params.parentSessionKey);
  if (explicit && explicit !== params.sessionKey) {
    return explicit;
  }
  const derived = resolveSessionParentSessionKey(params.sessionKey);
  if (derived && derived !== params.sessionKey) {
    return derived;
  }
  return null;
}

/** Resolves the persisted model override visible to the current session. */
export function resolveStoredModelOverride(params: {
<<<<<<< HEAD
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
<<<<<<< HEAD
  const directOverride = normalizeStoredOverrideModel({
    providerOverride: params.sessionEntry?.providerOverride,
    modelOverride: params.sessionEntry?.modelOverride,
  });
  const direct = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: directOverride.providerOverride,
    overrideModel: directOverride.modelOverride,
=======
  const direct = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.sessionEntry?.providerOverride,
    overrideModel: params.sessionEntry?.modelOverride,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
  if (direct) {
    return { ...direct, source: "session" };
  }
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
<<<<<<< HEAD
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  const normalizedParentOverride = normalizeStoredOverrideModel({
    providerOverride: parentEntry?.providerOverride,
    modelOverride: parentEntry?.modelOverride,
  });
  const parentOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalizedParentOverride.providerOverride,
    overrideModel: normalizedParentOverride.modelOverride,
=======
  if (!parentKey || !params.sessionStore) {
    return null;
  }
  const parentEntry = params.sessionStore[parentKey];
  const parentOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: parentEntry?.providerOverride,
    overrideModel: parentEntry?.modelOverride,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
  if (!parentOverride) {
    return null;
  }
  return { ...parentOverride, source: "parent" };
}

function resolveModelRefKey(params: {
  defaultProvider: string;
  overrideProvider?: string;
  overrideModel?: string;
}): string | null {
<<<<<<< HEAD
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: params.overrideProvider,
    modelOverride: params.overrideModel,
  });
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
  });
  if (!ref) {
    return null;
  }
  const normalizedRef = normalizeModelRef(ref.provider, ref.model);
  return modelKey(normalizedRef.provider, normalizedRef.model);
=======
  const ref = resolvePersistedOverrideModelRef(params);
  if (!ref) {
    return null;
  }
  const normalized = normalizeModelRef(ref.provider, ref.model);
  return modelKey(normalized.provider, normalized.model);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
    defaultProvider: params.defaultProvider,
    overrideProvider: params.primaryProvider ?? params.defaultProvider,
    overrideModel: params.primaryModel ?? params.defaultModel,
  });
  if (!primaryKey) {
    return false;
  }

  const originKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  if (originKey) {
    return originKey !== primaryKey;
  }

  const noticeSelectedKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideModel: normalizeOptionalString(entry.fallbackNoticeSelectedModel),
  });
  if (noticeSelectedKey) {
    return noticeSelectedKey !== primaryKey;
  }

  const storedOverrideKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.storedOverride.provider,
    overrideModel: params.storedOverride.model,
  });
  return storedOverrideKey !== null && storedOverrideKey !== primaryKey;
}
