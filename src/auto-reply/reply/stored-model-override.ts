import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import {
  modelKey,
  normalizeModelRef,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import type { SessionEntry } from "../../config/sessions/types.js";

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

function isSubagentSessionEntry(entry?: SessionEntry): boolean {
  return (
    (typeof entry?.spawnDepth === "number" && entry.spawnDepth >= 1) || Boolean(entry?.subagentRole)
  );
}

export function resolveStoredModelOverride(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  const direct = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.sessionEntry?.providerOverride,
    overrideModel: params.sessionEntry?.modelOverride,
  });
  if (direct) {
    return { ...direct, source: "session" };
  }
  // Spawned subagent sessions intentionally follow the configured subagent
  // model precedence (`agents.list[<id>].subagents.model` ->
  // `agents.defaults.subagents.model` -> `agents.list[<id>].model`) rather than
  // inheriting an interactive `/model` override the user applied to the parent
  // conversation. Without this guard the parent override would silently
  // replace the configured subagent default whenever the child entry has no
  // direct override of its own.
  if (isSubagentSessionEntry(params.sessionEntry)) {
    return null;
  }
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  if (!parentKey || !params.sessionStore) {
    return null;
  }
  const parentEntry = params.sessionStore[parentKey];
  const parentOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: parentEntry?.providerOverride,
    overrideModel: parentEntry?.modelOverride,
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
  const ref = resolvePersistedOverrideModelRef(params);
  if (!ref) {
    return null;
  }
  const normalized = normalizeModelRef(ref.provider, ref.model);
  return modelKey(normalized.provider, normalized.model);
}

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
