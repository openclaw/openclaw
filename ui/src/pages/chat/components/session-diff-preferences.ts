import { getSafeLocalStorage } from "../../../local-storage.ts";

type SessionDiffPreferences = { split: boolean; wrap: boolean };
const PREFERENCES_KEY = "openclaw.control.sessionDiff.v1";

export function loadSessionDiffPreferences(): SessionDiffPreferences {
  try {
    const parsed: unknown = JSON.parse(getSafeLocalStorage()?.getItem(PREFERENCES_KEY) ?? "null");
    return {
      split:
        typeof parsed === "object" && parsed !== null && "split" in parsed && parsed.split === true,
      wrap:
        typeof parsed === "object" && parsed !== null && "wrap" in parsed && parsed.wrap === true,
    };
  } catch {
    return { split: false, wrap: false };
  }
}

export function saveSessionDiffPreferences(preferences: SessionDiffPreferences) {
  try {
    getSafeLocalStorage()?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Restricted storage must not break the viewer.
  }
}
