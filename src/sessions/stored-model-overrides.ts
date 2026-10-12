// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
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
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

function resolveStoredOverrideFromEntry(
  params: {
    entry?: SessionEntry;
    defaultProvider: string;
    source: StoredModelOverride["source"];
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): StoredModelOverride | null {
  if (params.entry?.modelOverrideSource === "default") {
    return null;
  }
  const routeResolution = resolveSessionModelOverrideRouteResolution(params.entry);
  const normalized = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
    routeResolution,
  });
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalized.providerOverride,
    overrideModel: normalized.modelOverride,
    routeResolution,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
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
export function resolveDirectStoredModelOverride(
  params: {
    sessionEntry?: SessionEntry;
    defaultProvider: string;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): StoredModelOverride | null {
  return resolveStoredOverrideFromEntry({
    entry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
    source: "session",
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
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

/** @deprecated Use resolveStoredModelOverrideAsync. Removed at the next Plugin SDK major. */
export function resolveStoredModelOverride(params: {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  warnPluginSdkDeprecation({
    family: "session-model-override",
    method: "resolveStoredModelOverride",
    replacement: "resolveStoredModelOverrideAsync",
  });
  return resolveStoredModelOverrideCore({
    loadSessionEntry: params.loadSessionEntry,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
    defaultProvider: params.defaultProvider,
    allowPluginNormalization: params.allowPluginNormalization,
  });
}

/** Resolve inherited model selection without synchronous session-store access. */
export async function resolveStoredModelOverrideAsync(
  params: Omit<Parameters<typeof resolveStoredModelOverride>[0], "loadSessionEntry"> & {
    loadSessionEntry?: (
      sessionKey: string,
    ) => SessionEntry | undefined | Promise<SessionEntry | undefined>;
  },
): Promise<StoredModelOverride | null> {
  if (params.sessionEntry?.modelOverrideSource === "default") {
    return null;
  }
  const direct = resolveDirectStoredModelOverride(params);
  if (direct) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate(params);
  if (!parentKey) {
    return null;
  }
  const parentEntry =
    (await params.loadSessionEntry?.(parentKey)) ?? params.sessionStore?.[parentKey];
  return resolveParentStoredModelOverride(params, parentEntry);
}

/** Resolves the persisted model override visible to the current session. */
export function resolveStoredModelOverrideCore(
  params: Parameters<typeof resolveStoredModelOverride>[0] & ModelManifestNormalizationContext,
): StoredModelOverride | null {
  if (params.sessionEntry?.modelOverrideSource === "default") {
    return null;
  }
  const direct = resolveDirectStoredModelOverride(params);
  if (direct) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate(params);
  if (!parentKey) {
    return null;
  }
  const parentEntry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  return resolveParentStoredModelOverride(params, parentEntry);
}

function resolveParentStoredModelOverride(
  params: {
    defaultProvider: string;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
  parentEntry: SessionEntry | undefined,
): StoredModelOverride | null {
  if (hasSessionActiveAutoModelFallback(parentEntry)) {
    return null;
  }
  return resolveStoredOverrideFromEntry({
    entry: parentEntry,
    defaultProvider: params.defaultProvider,
    source: "parent",
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}
