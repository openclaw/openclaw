import type { SessionEntry } from "../config/sessions.js";
import { lookupContextTokens } from "../agents/context.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
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
  let modelChanged = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
      modelChanged = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
      modelChanged = true;
    }
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
      modelChanged = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
      modelChanged = true;
    }
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

  // Refresh contextTokens only when the model/provider actually changed,
  // not on profile-only changes (avoids unnecessary lookups).
  if (modelChanged) {
    const effectiveModel = entry.modelOverride;
    if (effectiveModel) {
      const fresh = lookupContextTokens(effectiveModel);
      if (typeof fresh === "number" && fresh > 0) {
        entry.contextTokens = fresh;
      }
    } else {
      // Reverted to default — clear so it gets re-resolved from config.
      delete entry.contextTokens;
    }
  }

  if (updated) {
    entry.updatedAt = Date.now();
  }

  return { updated };
}
