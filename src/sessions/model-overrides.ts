import type { SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const AUTO_MODEL_OVERRIDE_FAILBACK_MS = 30_000;

export function resolveAutoModelOverrideExpiresAt(now = Date.now()): number {
  return now + AUTO_MODEL_OVERRIDE_FAILBACK_MS;
}

export function isAutoModelOverrideExpired(
  entry:
    | Pick<SessionEntry, "modelOverride" | "modelOverrideSource" | "modelOverrideExpiresAt">
    | undefined,
  now = Date.now(),
): boolean {
  if (!entry?.modelOverride || entry.modelOverrideSource !== "auto") {
    return false;
  }
  const expiresAt = entry.modelOverrideExpiresAt;
  // Older auto overrides predate the expiry field and may include non-fallback
  // selections (for example spawned sub-agent defaults). Preserve them until a
  // new fallback pin records an explicit expiry.
  if (expiresAt === undefined) {
    return false;
  }
  return typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function clearExpiredAutoModelOverrideFromSessionEntry(params: {
  entry: SessionEntry | undefined;
  now?: number;
}): { updated: boolean } {
  const { entry } = params;
  const now = params.now ?? Date.now();
  if (!isAutoModelOverrideExpired(entry, now)) {
    return { updated: false };
  }

  let updated = false;
  const clear = (key: keyof SessionEntry) => {
    if (Object.hasOwn(entry!, key)) {
      delete entry![key];
      updated = true;
    }
  };

  clear("providerOverride");
  clear("modelOverride");
  clear("modelOverrideSource");
  clear("modelOverrideExpiresAt");
  clear("fallbackNoticeSelectedModel");
  clear("fallbackNoticeActiveModel");
  clear("fallbackNoticeReason");
  if (entry!.authProfileOverrideSource !== "user") {
    clear("authProfileOverride");
    clear("authProfileOverrideSource");
    clear("authProfileOverrideCompactionCount");
  }
  if (updated) {
    entry!.updatedAt = now;
  }
  return { updated };
}

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
    if (entry.modelOverrideExpiresAt !== undefined) {
      delete entry.modelOverrideExpiresAt;
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
    const nextExpiresAt =
      selectionSource === "auto" ? resolveAutoModelOverrideExpiresAt() : undefined;
    if (nextExpiresAt === undefined) {
      if (entry.modelOverrideExpiresAt !== undefined) {
        delete entry.modelOverrideExpiresAt;
        updated = true;
      }
    } else if (entry.modelOverrideExpiresAt !== nextExpiresAt) {
      entry.modelOverrideExpiresAt = nextExpiresAt;
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
