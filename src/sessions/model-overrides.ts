import type { SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

/**
 * Clears failover-persisted session model state (`modelOverrideSource: "auto"`) plus
 * sticky runtime `model` / `modelProvider` fields so the next inbound turn re-resolves
 * the agent primary from config instead of staying pinned on the last fallback model.
 *
 * Preserves `authProfileOverride*` when `authProfileOverrideSource === "user"` — failover
 * can persist `modelOverrideSource: "auto"` alongside a user-selected auth profile.
 */
export function clearAutoFailoverSessionModelStickyState(entry: SessionEntry): boolean {
  if (entry.modelOverrideSource !== "auto") {
    return false;
  }
  let updated = false;
  const del = (key: keyof SessionEntry) => {
    if (Object.hasOwn(entry, key)) {
      delete entry[key];
      updated = true;
    }
  };
  del("providerOverride");
  del("modelOverride");
  del("modelOverrideSource");
  if (entry.authProfileOverrideSource !== "user") {
    del("authProfileOverride");
    del("authProfileOverrideSource");
    del("authProfileOverrideCompactionCount");
  }
  del("model");
  del("modelProvider");
  del("contextTokens");
  del("fallbackNoticeSelectedModel");
  del("fallbackNoticeActiveModel");
  del("fallbackNoticeReason");
  if (updated) {
    entry.updatedAt = Date.now();
  }
  return updated;
}

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
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
    if (entry.modelOverrideSource !== selectionSource) {
      entry.modelOverrideSource = selectionSource;
      updated = true;
    }
  }

  // Model overrides supersede previously recorded runtime model identity.
  // If runtime fields are stale (or the override changed), clear them so status
  // surfaces reflect the selected model immediately.
  const runtimeModel = normalizeOptionalString(entry.model) ?? "";
  const runtimeProvider = normalizeOptionalString(entry.modelProvider) ?? "";
  const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
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
    if (selectionUpdated && params.markLiveSwitchPending) {
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}
