import { isRecord } from "@openclaw/normalization-core";
import { patchSettings, type UiSettings } from "../../app/settings.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { updateSidebarSessionLayout } from "./sidebar-layout-persistence.ts";
import { openSlot, type SidebarLayout } from "./sidebar-layout.ts";

const MIGRATION_MARKER_KEY = "openclaw.chat.sidePanel.legacyDockVisibility.v1";

function legacyDockWasOpen(storage: Storage, storageKey: string): boolean {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return false;
    }
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.open === true;
  } catch {
    return false;
  }
}

function markMigrationComplete(storage: Storage): void {
  try {
    storage.setItem(MIGRATION_MARKER_KEY, "1");
  } catch {
    // Best effort: a persisted session layout still prevents duplicate migration.
  }
}

function migrationIsComplete(storage: Storage): boolean {
  try {
    return storage.getItem(MIGRATION_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Move the shipped global Browser/Desktop visibility into the current session
 * once. A marker prevents that global preference from opening unrelated future
 * sessions, while an existing per-session layout always wins unchanged.
 */
export function migrateLegacyDockVisibility(params: {
  settings: UiSettings;
  sessionKey: string;
  browserAvailable: boolean;
  desktopAvailable: boolean;
  storage?: Storage | null;
}): UiSettings {
  const sessionKey = params.sessionKey.trim();
  const storage = params.storage === undefined ? getSafeLocalStorage() : params.storage;
  if (!sessionKey || !storage || migrationIsComplete(storage)) {
    return params.settings;
  }
  if (params.settings.sidebarSessionLayouts?.[sessionKey] !== undefined) {
    markMigrationComplete(storage);
    return params.settings;
  }
  let layout: SidebarLayout = { columns: [] };
  for (const [storageKey, slot, available] of [
    ["openclaw.browser.panel.v1", "browser", params.browserAvailable],
    ["openclaw.desktopPanel", "desktop", params.desktopAvailable],
  ] as const) {
    if (available && legacyDockWasOpen(storage, storageKey)) {
      layout = openSlot(layout, slot);
    }
  }
  const settings =
    layout.columns.length > 0
      ? patchSettings({
          sidebarSessionLayouts: updateSidebarSessionLayout(
            params.settings.sidebarSessionLayouts,
            sessionKey,
            layout,
          ),
        })
      : params.settings;
  markMigrationComplete(storage);
  return settings;
}
