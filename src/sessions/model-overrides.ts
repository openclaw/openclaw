import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "./model-selection-error.js";

export {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "./model-selection-error.js";

/** User or automatic model/provider override selection for a session entry. */
export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export const MODEL_SELECTION_LOCKED_RESET_MESSAGE =
  "This session cannot be reset while model selection is locked.";
export const MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE =
  "Model-selection-locked sessions cannot create child sessions from parent context.";

export function isModelSelectionLocked(entry: SessionEntry | undefined): boolean {
  return entry?.modelSelectionLocked === true;
}

/** A locked harness owns both model selection and transcript lineage. */
export function assertModelSelectionUnlocked(
  entry: SessionEntry,
  message = MODEL_SELECTION_LOCKED_MESSAGE,
): void {
  if (isModelSelectionLocked(entry)) {
    throw new ModelSelectionLockedError(message);
  }
}

function clearDefinedFields(entry: SessionEntry, ...keys: (keyof SessionEntry)[]): boolean {
  let updated = false;
  for (const key of keys) {
    if (entry[key] !== undefined) {
      delete entry[key];
      updated = true;
    }
  }
  return updated;
}

function setField<K extends keyof SessionEntry>(
  entry: SessionEntry,
  key: K,
  value: SessionEntry[K],
): boolean {
  if (entry[key] === value) {
    return false;
  }
  entry[key] = value;
  return true;
}

/** Applies a model/auth-profile override to a session entry and clears stale runtime fields. */
export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  modelFallbackPolicy?: "configured";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  assertModelSelectionUnlocked(entry);
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
  let updated = false;
  let selectionUpdated = false;
  let profileUpdated = false;

  if (selection.isDefault) {
    if (params.explicitDefaultSelection && entry.modelOverrideSource !== "default") {
      entry.modelOverrideSource = "default";
      updated = true;
      selectionUpdated = true;
    } else if (!params.explicitDefaultSelection && entry.modelOverrideSource !== undefined) {
      delete entry.modelOverrideSource;
      updated = true;
      selectionUpdated = true;
    }
    for (const key of ["providerOverride", "modelOverride"] as const) {
      if (entry[key]) {
        delete entry[key];
        updated = true;
        selectionUpdated = true;
      }
    }
    if (entry.modelOverrideRouteResolution) {
      delete entry.modelOverrideRouteResolution;
      updated = true;
    }
  } else {
    selectionUpdated = setField(entry, "providerOverride", selection.provider);
    selectionUpdated = setField(entry, "modelOverride", selection.model) || selectionUpdated;
    updated = setField(entry, "modelOverrideSource", selectionSource) || selectionUpdated;
    updated = setField(entry, "modelOverrideRouteResolution", "resolved") || updated;
  }
  updated =
    clearDefinedFields(
      entry,
      "modelOverrideFallbackOriginProvider",
      "modelOverrideFallbackOriginModel",
    ) || updated;

  const previousModelFallbackPolicy = entry.modelFallbackPolicy;
  // The preference belongs to this selection, never to the configured default
  // or to a later unmarked strict selection.
  if (selection.isDefault || params.modelFallbackPolicy !== "configured") {
    if (entry.modelFallbackPolicy !== undefined) {
      delete entry.modelFallbackPolicy;
      updated = true;
    }
  } else if (entry.modelFallbackPolicy !== "configured") {
    entry.modelFallbackPolicy = "configured";
    updated = true;
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
    updated = clearDefinedFields(entry, "model", "modelProvider") || updated;
  }

  // Switching to the default may only replace steering/fallback runtime fields.
  if (selection.isDefault && runtimePresent && !runtimeAligned) {
    selectionUpdated = true;
  }

  // contextTokens are derived from the active session model. When the selected
  // model changes (or runtime model is already stale), the cached window can
  // pin the session to an older/smaller limit until another run refreshes it.
  const shouldClearModelDerivedState = selectionUpdated || (runtimePresent && !runtimeAligned);
  if (shouldClearModelDerivedState) {
    updated =
      clearDefinedFields(entry, "contextTokens", "contextTokensSource", "contextBudgetStatus") ||
      updated;
  }

  if (profileOverride) {
    profileUpdated = setField(entry, "authProfileOverride", profileOverride);
    profileUpdated =
      setField(entry, "authProfileOverrideSource", profileOverrideSource) || profileUpdated;
  } else if (!params.preserveAuthProfileOverride) {
    for (const key of ["authProfileOverride", "authProfileOverrideSource"] as const) {
      if (entry[key]) {
        delete entry[key];
        profileUpdated = true;
      }
    }
  }
  updated = profileUpdated || updated;
  if (profileOverride || !params.preserveAuthProfileOverride) {
    updated = clearDefinedFields(entry, "authProfileOverrideCompactionCount") || updated;
  }

  // Clear stale fallback notice when the user explicitly switches models.
  if (updated) {
    if (
      (selectionUpdated ||
        profileUpdated ||
        previousModelFallbackPolicy !== entry.modelFallbackPolicy) &&
      params.markLiveSwitchPending
    ) {
      // Pending without modelOverride is the deliberate encoding for "switch
      // back to the agent default": the default branch above also clears the
      // runtime model fields so live-switch resolution lands on the default.
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNotice;
    entry.updatedAt = Date.now();
  }

  return { updated };
}

/** Repairs overrides where legacy provider/model fields were stored as provider/model strings. */
export function repairProviderWrappedModelOverride(params: {
  entry: SessionEntry;
  defaultProvider: string;
  defaultModel?: string;
}): { updated: boolean } {
  const overrideProvider = normalizeOptionalString(params.entry.providerOverride);
  const overrideModel = normalizeOptionalString(params.entry.modelOverride);
  if (!overrideProvider || !overrideModel) {
    return { updated: false };
  }

  const wrappedModel = `${overrideProvider}/${overrideModel}`;
  const runtimeProvider = normalizeOptionalString(params.entry.modelProvider);
  const runtimeModel = normalizeOptionalString(params.entry.model);
  if (runtimeProvider && runtimeModel === wrappedModel && runtimeProvider !== overrideProvider) {
    return applyModelOverrideToSessionEntry({
      entry: params.entry,
      selection: {
        provider: runtimeProvider,
        model: runtimeModel,
        isDefault:
          runtimeProvider === params.defaultProvider && runtimeModel === params.defaultModel,
      },
      selectionSource: params.entry.modelOverrideSource === "auto" ? "auto" : "user",
      modelFallbackPolicy: params.entry.modelFallbackPolicy,
    });
  }

  if (params.defaultProvider !== overrideProvider && params.defaultModel === wrappedModel) {
    return applyModelOverrideToSessionEntry({
      entry: params.entry,
      selection: {
        provider: params.defaultProvider,
        model: params.defaultModel,
        isDefault: true,
      },
    });
  }

  return { updated: false };
}
