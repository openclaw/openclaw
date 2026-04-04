import type { SessionEntry } from "../config/sessions.js";
import { normalizeMainKey, parseAgentSessionKey } from "../routing/session-key.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export type ModelOverrideSource = "user";

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  modelOverrideSource?: ModelOverrideSource;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const modelOverrideSource = params.modelOverrideSource ?? "user";
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  let updated = false;
  let selectionUpdated = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideSource) {
      delete entry.modelOverrideSource;
      updated = true;
    }
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
      selectionUpdated = true;
    }
  }

  // Model overrides supersede previously recorded runtime model identity.
  // If runtime fields are stale (or the override changed), clear them so status
  // surfaces reflect the selected model immediately.
  const runtimeModel = typeof entry.model === "string" ? entry.model.trim() : "";
  const runtimeProvider = typeof entry.modelProvider === "string" ? entry.modelProvider.trim() : "";
  const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
  if (
    !selection.isDefault &&
    entry.modelOverrideSource !== modelOverrideSource &&
    (selectionUpdated || (runtimePresent && !runtimeAligned))
  ) {
    entry.modelOverrideSource = modelOverrideSource;
    updated = true;
  }
  if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
    if (entry.model !== undefined) {
      delete entry.model;
      updated = true;
    }
    if (entry.modelProvider !== undefined) {
      delete entry.modelProvider;
      updated = true;
    }
  }

  // contextTokens are derived from the active session model. When the selected
  // model changes (or runtime model is already stale), the cached window can
  // pin the session to an older/smaller limit until another run refreshes it.
  if (
    entry.contextTokens !== undefined &&
    (selectionUpdated || (runtimePresent && !runtimeAligned))
  ) {
    delete entry.contextTokens;
    updated = true;
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  // Clear stale fallback notice when the user explicitly switches models.
  if (updated) {
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProviderKey(value: string | undefined): string | undefined {
  const trimmed = trimToUndefined(value);
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function shouldResetLegacyMainSessionModelOverride(params: {
  entry: SessionEntry;
  sessionKey?: string;
  mainKey?: string;
  defaultProvider: string;
  defaultModel: string;
}): boolean {
  const sessionKey = trimToUndefined(params.sessionKey);
  if (!sessionKey) {
    return false;
  }

  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || parsed.rest !== normalizeMainKey(params.mainKey)) {
    return false;
  }

  if (trimToUndefined(params.entry.modelOverrideSource)) {
    return false;
  }

  const overrideModel = trimToUndefined(params.entry.modelOverride);
  const defaultModel = trimToUndefined(params.defaultModel);
  if (!overrideModel || !defaultModel || overrideModel !== defaultModel) {
    return false;
  }

  const overrideProvider = normalizeProviderKey(
    trimToUndefined(params.entry.providerOverride) ?? params.defaultProvider,
  );
  const defaultProvider = normalizeProviderKey(params.defaultProvider);
  if (!overrideProvider || !defaultProvider || overrideProvider === defaultProvider) {
    return false;
  }

  const runtimeModel = trimToUndefined(params.entry.model);
  const runtimeProvider = normalizeProviderKey(params.entry.modelProvider);
  return runtimeModel === overrideModel && runtimeProvider === overrideProvider;
}

export function resetLegacyMainSessionModelOverride(params: {
  entry: SessionEntry;
  sessionKey?: string;
  mainKey?: string;
  defaultProvider: string;
  defaultModel: string;
}): { updated: boolean } {
  if (!shouldResetLegacyMainSessionModelOverride(params)) {
    return { updated: false };
  }
  return applyModelOverrideToSessionEntry({
    entry: params.entry,
    selection: {
      provider: params.defaultProvider,
      model: params.defaultModel,
      isDefault: true,
    },
  });
}
