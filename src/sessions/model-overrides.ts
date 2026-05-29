import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export function hasStaleAutoRuntimeAuthProfileSelection(
  entry:
    | Pick<
        SessionEntry,
        | "authProfileOverride"
        | "authProfileOverrideSource"
        | "providerOverride"
        | "modelOverride"
        | "modelProvider"
        | "model"
      >
    | undefined,
  expectedSelection: { provider: string; model: string; config?: OpenClawConfig },
): boolean {
  const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(entry?.model);
  const expectedProvider = normalizeOptionalString(expectedSelection.provider);
  const expectedModel = normalizeOptionalString(expectedSelection.model);
  const runtimeMatchesExpected =
    runtimeProvider !== undefined &&
    runtimeModel !== undefined &&
    expectedProvider !== undefined &&
    expectedModel !== undefined &&
    areRuntimeModelRefsEquivalent(
      `${runtimeProvider}/${runtimeModel}`,
      `${expectedProvider}/${expectedModel}`,
      { config: expectedSelection.config },
    );
  return (
    entry?.authProfileOverrideSource === "auto" &&
    normalizeOptionalString(entry.authProfileOverride) !== undefined &&
    normalizeOptionalString(entry.providerOverride) === undefined &&
    normalizeOptionalString(entry.modelOverride) === undefined &&
    runtimeProvider !== undefined &&
    runtimeModel !== undefined &&
    expectedProvider !== undefined &&
    expectedModel !== undefined &&
    !runtimeMatchesExpected
  );
}

export function clearStaleAutoRuntimeAuthProfileSelection(
  entry: SessionEntry,
  expectedSelection: { provider: string; model: string; config?: OpenClawConfig },
): { updated: boolean } {
  if (!hasStaleAutoRuntimeAuthProfileSelection(entry, expectedSelection)) {
    return { updated: false };
  }

  let updated = false;
  const clear = (key: keyof SessionEntry) => {
    if (entry[key] !== undefined) {
      delete entry[key];
      updated = true;
    }
  };

  clear("modelProvider");
  clear("model");
  clear("contextTokens");
  clear("contextBudgetStatus");
  clear("authProfileOverride");
  clear("authProfileOverrideSource");
  clear("authProfileOverrideCompactionCount");
  clear("fallbackNoticeSelectedModel");
  clear("fallbackNoticeActiveModel");
  clear("fallbackNoticeReason");

  if (updated) {
    entry.updatedAt = Date.now();
  }

  return { updated };
}

function clearFallbackOrigin(entry: SessionEntry): boolean {
  let updated = false;
  if (entry.modelOverrideFallbackOriginProvider !== undefined) {
    delete entry.modelOverrideFallbackOriginProvider;
    updated = true;
  }
  if (entry.modelOverrideFallbackOriginModel !== undefined) {
    delete entry.modelOverrideFallbackOriginModel;
    updated = true;
  }
  return updated;
}

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
  let updated = false;
  let selectionUpdated = false;
  let profileUpdated = false;

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
    updated = clearFallbackOrigin(entry) || updated;
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
    updated = clearFallbackOrigin(entry) || updated;
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
  if (
    entry.contextBudgetStatus !== undefined &&
    (selectionUpdated || (runtimePresent && !runtimeAligned))
  ) {
    delete entry.contextBudgetStatus;
    updated = true;
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else if (!params.preserveAuthProfileOverride) {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  // Clear stale fallback notice when the user explicitly switches models.
  if (updated) {
    if ((selectionUpdated || profileUpdated) && params.markLiveSwitchPending) {
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}

function wrappedOverrideModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

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

  const wrappedModel = wrappedOverrideModel(overrideProvider, overrideModel);
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
