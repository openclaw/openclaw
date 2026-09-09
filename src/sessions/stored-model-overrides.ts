// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../agents/model-selection-persisted.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  hasSessionActiveAutoModelFallback,
  resolveSessionModelOverrideRouteResolution,
} from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

function resolveStoredOverrideFromEntry(params: {
  entry?: SessionEntry;
  defaultProvider: string;
  source: StoredModelOverride["source"];
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  if (params.entry?.modelOverrideSource === "default") {
    return null;
  }
  const normalized = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  const routeResolution = resolveSessionModelOverrideRouteResolution(params.entry);
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalized.providerOverride,
    overrideModel: normalized.modelOverride,
    // Resolved overrides are already canonical. Re-running provider normalization
    // can rewrite their persisted identity while projecting a detail row.
    allowPluginNormalization:
      routeResolution === "resolved" ? false : params.allowPluginNormalization,
  });
  return ref
    ? {
        ...ref,
        source: params.source,
        routeResolution,
      }
    : null;
}

/** Resolves only the current session's persisted model override. */
export function resolveDirectStoredModelOverride(params: {
  sessionEntry?: SessionEntry;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  return resolveStoredOverrideFromEntry({
    entry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
    source: "session",
    allowPluginNormalization: params.allowPluginNormalization,
  });
}

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
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  if (params.sessionEntry?.modelOverrideSource === "default") {
    return null;
  }
  const direct = resolveDirectStoredModelOverride({
    sessionEntry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (direct) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  if (hasSessionActiveAutoModelFallback(parentEntry)) {
    return null;
  }
  return resolveStoredOverrideFromEntry({
    entry: parentEntry,
    defaultProvider: params.defaultProvider,
    source: "parent",
    allowPluginNormalization: params.allowPluginNormalization,
  });
}
