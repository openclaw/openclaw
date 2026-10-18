import { getSafeLocalStorage } from "../../../local-storage.ts";

export type SessionDiffMode = "auto" | "unified" | "split";
type SessionDiffPreferences = {
  split: boolean;
  wrap: boolean;
  mode?: SessionDiffMode;
  wordDiffs?: boolean;
};
const PREFERENCES_KEY = "openclaw.control.sessionDiff.v1";

export function loadSessionDiffPreferences(): SessionDiffPreferences {
  try {
    const parsed: unknown = JSON.parse(getSafeLocalStorage()?.getItem(PREFERENCES_KEY) ?? "null");
    return {
      split:
        typeof parsed === "object" && parsed !== null && "split" in parsed && parsed.split === true,
      wrap:
        typeof parsed === "object" && parsed !== null && "wrap" in parsed && parsed.wrap === true,
      mode:
        typeof parsed === "object" &&
        parsed !== null &&
        "mode" in parsed &&
        (parsed.mode === "split" || parsed.mode === "unified")
          ? parsed.mode
          : "auto",
      wordDiffs: !(
        typeof parsed === "object" &&
        parsed !== null &&
        "wordDiffs" in parsed &&
        parsed.wordDiffs === false
      ),
    };
  } catch {
    return { split: false, wrap: false, mode: "auto", wordDiffs: true };
  }
}

export function saveSessionDiffPreferences(preferences: SessionDiffPreferences) {
  try {
    getSafeLocalStorage()?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Restricted storage must not break the viewer.
  }
}
