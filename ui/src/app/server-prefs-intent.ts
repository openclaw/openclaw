import {
  prefValuesEqual,
  clearSidebarEntriesMetadata,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import type { UiSettings } from "./settings-contract.ts";

type UiPrefIntent = "write" | "server" | "device-local";
let requestedUiPrefIntents: Partial<Record<SyncedPrefKey, UiPrefIntent>> = {};

export function requestServerUiPrefIntent(key: SyncedPrefKey, intent: UiPrefIntent): void {
  const previous = requestedUiPrefIntents[key];
  // Match the former request sets: local resets suppress server resets and writes;
  // server resets suppress writes. Each preference consumes exactly one intent.
  if (previous !== "device-local" && (previous !== "server" || intent === "device-local")) {
    requestedUiPrefIntents[key] = intent;
  }
}

export function resetServerUiPrefIntent(): void {
  requestedUiPrefIntents = {};
}

/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    const intent = requestedUiPrefIntents[key];
    delete requestedUiPrefIntents[key];
    if (intent === "device-local") {
      continue;
    }
    if (intent === "server") {
      prefs[key] = null;
      continue;
    }
    const specification = SYNCED_PREFS[key];
    const previousValue = specification.local(previous);
    const nextValue = specification.local(next);
    if (intent !== "write" && prefValuesEqual(previousValue, nextValue)) {
      continue;
    }
    if (nextValue === undefined) {
      // JSON merge patch removes keys via explicit null.
      if (specification.write) {
        prefs[key] = null;
      }
      continue;
    }
    // SAFETY: SYNCED_PREFS[key].local returns the value type owned by this exact key.
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  if (prefs.sidebarEntries !== undefined) {
    prefs.sidebarEntriesBase = [...previous.sidebarEntries];
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
/** The observed base is part of pin intent, not independently acknowledgeable metadata. */
export function prefIntentMatches(left: ServerUiPrefs, right: ServerUiPrefs, key: string): boolean {
  return (
    prefValuesEqual(left[key], right[key]) &&
    (key !== "sidebarEntries" ||
      (prefValuesEqual(left.sidebarEntriesBase, right.sidebarEntriesBase) &&
        left.sidebarEntriesOrder === right.sidebarEntriesOrder))
  );
}

/** Preserve observations of untouched entries while folding explicit additions/removals. */
export function foldSidebarEntriesBase(
  base: readonly string[],
  previous: readonly string[],
  next: readonly string[],
): string[] {
  return [
    ...base.filter((entry) => previous.includes(entry) || !next.includes(entry)),
    ...previous.filter((entry) => !next.includes(entry) && !base.includes(entry)),
  ];
}

export function hasSidebarOrderIntent(prefs: ServerUiPrefs): boolean {
  // Common entries must retain increasing positions; membership edits alone do not reorder.
  const base = prefs.sidebarEntriesBase ?? [];
  let index = -1;
  return (
    prefs.sidebarEntriesOrder === true ||
    Boolean(
      prefs.sidebarEntries?.some((entry) => {
        const position = base.indexOf(entry);
        if (position < 0) {
          return false;
        }
        const reordered = position < index;
        index = position;
        return reordered;
      }),
    )
  );
}

/** Fold local operations into durable intent; untouched entries keep their observation. */
export function mergePendingUiPrefs(
  pending: ServerUiPrefs | null,
  next: ServerUiPrefs,
): ServerUiPrefs {
  const merged = { ...pending, ...next };
  if (next.sidebarEntries) {
    merged.sidebarEntriesOrder = next.sidebarEntriesOrder;
  }
  if (
    next.sidebarEntries &&
    pending?.sidebarEntries &&
    pending.sidebarEntriesBase &&
    prefValuesEqual(next.sidebarEntriesBase, pending.sidebarEntries)
  ) {
    // Added entries must still be additions if an older write never commits; removed local
    // additions must remain removals if it does commit, including after this tab reloads.
    // A reorder followed by its inverse is still authored order while either write is uncertain.
    merged.sidebarEntriesBase = foldSidebarEntriesBase(
      pending.sidebarEntriesBase,
      pending.sidebarEntries,
      next.sidebarEntries,
    );
    merged.sidebarEntriesOrder =
      hasSidebarOrderIntent(pending) || hasSidebarOrderIntent(next) || undefined;
  }
  if (!merged.sidebarEntries) {
    clearSidebarEntriesMetadata(merged);
  }
  return merged;
}

/** Browser metadata belongs to its owning intent, never an independently dispatched/settled key. */
export function pendingUiPrefKeys(prefs: ServerUiPrefs): string[] {
  return Object.keys(prefs).filter(
    (key) => !["sidebarEntriesBase", "sidebarEntriesOrder", "navigationConfirmation"].includes(key),
  );
}
