import { getSafeLocalStorage } from "../../local-storage.ts";

const VIEW_STORAGE_KEY = "openclaw:dashboards:view";

export type DashboardsView = "cards" | "list";

export function loadStoredDashboardsView(): DashboardsView {
  return getSafeLocalStorage()?.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "cards";
}

export function saveStoredDashboardsView(view: DashboardsView): void {
  try {
    getSafeLocalStorage()?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage may be unavailable or full; the in-memory selection still applies.
  }
}
