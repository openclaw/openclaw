import type { SessionEntry } from "../config/sessions.js";
import { AUTO_MODEL, isAutoModel } from "../shared/model-constants.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
  /** True when selection is AUTO_MODEL (auto routing). */
  isAuto?: boolean;
};

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  let updated = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
    }
    delete entry.autoModelRoutingStatus;
  } else if (selection.isAuto || isAutoModel(selection.model)) {
    if (entry.modelOverride !== AUTO_MODEL) {
      entry.modelOverride = AUTO_MODEL;
      updated = true;
    }
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
    }
    delete entry.autoModelRoutingStatus;
    // Preserve lastNonAutoModel* when switching to auto (don't overwrite).
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
    }
    // Update last non-auto manual selection for restore when switching back to /model auto.
    entry.lastNonAutoModelProvider = selection.provider;
    entry.lastNonAutoModel = selection.model;
    delete entry.autoModelRoutingStatus;
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
