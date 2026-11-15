import { resolveMessageLocale } from "../../shared/message-locale.js";

/** Builds recovery instructions while preserving the existing session mapping. */
export function buildContextOverflowRecoveryText(locale?: string): string {
  if (resolveMessageLocale(locale) === "de") {
    return "⚠️ Die automatische Komprimierung konnte diese Anfrage nicht wiederherstellen. Das Gespräch bleibt der aktuellen Sitzung zugeordnet. Versuche es erneut, verwende /compact oder starte mit /new ein neues Gespräch.\n\nDu kannst auch ein Modell mit einem größeren Kontextfenster wählen.";
  }
  return (
    "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session." +
    "\n\nTry starting a fresh session or using a model with a larger context window."
  );
}
