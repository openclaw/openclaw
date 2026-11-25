import { resolveSessionStartupErrorPresentation } from "../../../../src/shared/session-startup-error-presentation.js";
import { t } from "../../lib/reactive/i18n.ts";

/** The shared classifier owns categories; the UI owns localized presentation. */
export function resolveChatStartupErrorPresentation(error: string) {
  const presentation = resolveSessionStartupErrorPresentation(error);
  if (!presentation) {
    return undefined;
  }
  const title = t(`chat.recovery.${presentation.category}Title`);
  const recovery = t(`chat.recovery.${presentation.category}Recovery`);
  return { ...presentation, title, recovery, message: `${title} ${recovery}` };
}
