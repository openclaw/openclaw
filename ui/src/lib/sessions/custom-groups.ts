import { getSafeLocalStorage } from "../../local-storage.ts";

export const SESSION_CUSTOM_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";

export function loadStoredSessionCustomGroups(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [
      ...new Set(
        parsed.flatMap((name) => {
          const normalized = typeof name === "string" ? name.trim() : "";
          return normalized ? [normalized] : [];
        }),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveStoredSessionCustomGroups(groups: readonly string[]) {
  try {
    getSafeLocalStorage()?.setItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Assigned groups still persist server-side via the session category field.
  }
}
