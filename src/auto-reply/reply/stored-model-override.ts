import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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

export function resolveStoredModelOverride(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  // Issue #68706: auto-source overrides are transient fallback selections
  // that should only survive for the duration of the current turn.  If the
  // process crashed after persisting the override but before the rollback
  // ran, a stale "auto" override would pin the session to the fallback model
  // indefinitely.  Ignore it here so the default model is re-resolved.
  const direct = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.sessionEntry?.providerOverride,
    overrideModel: params.sessionEntry?.modelOverride,
  });
  if (direct && params.sessionEntry?.modelOverrideSource !== "auto") {
    return { ...direct, source: "session" };
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
