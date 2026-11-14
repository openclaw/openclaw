import { getSafeLocalStorage } from "../../../local-storage.ts";

const KEY = "openclaw.control.modelProviderOrder.v1";
const FAVORITES_TAB_KEY = "openclaw.control.modelPickerFavoritesTab.v1";

export function loadModelProviderOrder(): string[] {
  try {
    const value: unknown = JSON.parse(getSafeLocalStorage()?.getItem(KEY) ?? "null");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Whether the last tab the user chose in the model picker was Favorites. */
export function loadModelPickerFavoritesTab(): boolean {
  return getSafeLocalStorage()?.getItem(FAVORITES_TAB_KEY) === "1";
}

export function saveModelPickerFavoritesTab(favorites: boolean): void {
  try {
    getSafeLocalStorage()?.setItem(FAVORITES_TAB_KEY, favorites ? "1" : "0");
  } catch {
    // Storage restrictions only lose the remembered tab.
  }
}

export function saveModelProviderOrder(order: string[]): void {
  try {
    getSafeLocalStorage()?.setItem(KEY, JSON.stringify(order));
  } catch {
    // Storage restrictions must not prevent reordering the current picker.
  }
}
