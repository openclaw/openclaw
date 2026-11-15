/** Language of host-authored conversation notices, independent of model prompts and UI chrome. */
export type MessageLocale = "en" | "de";
export const MESSAGE_LOCALE_PREFERENCE_KEY = "messages.locale";

/** Missing means inherit; an explicitly unsupported locale falls back to English. */
export function normalizeMessageLocale(value: unknown): MessageLocale | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return /^de(?:-|$)/i.test(value.trim()) ? "de" : "en";
}

export function resolveMessageLocale(...preferences: unknown[]): MessageLocale {
  for (const preference of preferences) {
    const locale = normalizeMessageLocale(preference);
    if (locale) {
      return locale;
    }
  }
  return "en";
}
