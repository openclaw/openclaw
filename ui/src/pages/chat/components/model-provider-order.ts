import { getSafeLocalStorage } from "../../../local-storage.ts";

const KEY = "openclaw.control.modelProviderOrder.v1";

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

export function saveModelProviderOrder(order: string[]): void {
  try {
    getSafeLocalStorage()?.setItem(KEY, JSON.stringify(order));
  } catch {
    // Storage restrictions must not prevent reordering the current picker.
  }
}
