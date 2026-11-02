import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getSafeLocalStorage } from "../../local-storage.ts";
export type AnswerLensSettings = {
  coverage: "gist" | "condensed" | "full";
  wording: "plain" | "clearer" | "technical" | "original";
};

const key = "openclaw.control.answerLens.v1";
let volatileChoice: AnswerLensSettings | undefined;

export function readAnswerLensPreference(): AnswerLensSettings | undefined {
  if (volatileChoice) {
    return volatileChoice;
  }
  try {
    const value = asOptionalRecord(JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "null"));
    if (
      value &&
      (value.coverage === "full" || value.coverage === "condensed" || value.coverage === "gist") &&
      (value.wording === "technical" ||
        value.wording === "clearer" ||
        value.wording === "plain" ||
        (value.wording === "original" && value.coverage === "full"))
    ) {
      return { coverage: value.coverage, wording: value.wording };
    }
  } catch {
    // A denied or damaged preference store must not prevent reading answers.
  }
  return undefined;
}

export function rememberAnswerLensPreference(settings: AnswerLensSettings): void {
  try {
    const storage = getSafeLocalStorage();
    if (storage) {
      storage.setItem(key, JSON.stringify(settings));
      volatileChoice = undefined;
      return;
    }
  } catch {
    // Keep the selection usable when persistent storage is unavailable.
  }
  volatileChoice = settings;
}
