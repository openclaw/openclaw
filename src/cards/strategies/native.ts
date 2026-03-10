/**
 * Native pass-through strategy for channels that support Adaptive Cards directly
 * (e.g. Microsoft Teams, Webex).
 *
 * Returns the card JSON as an attachment with the standard AC content type.
 */

import type { ParsedAdaptiveCard } from "../parse.js";
import type { CardRenderResult, CardRenderStrategy } from "../types.js";

export const nativeStrategy: CardRenderStrategy = {
  name: "native",
  render(parsed: ParsedAdaptiveCard): CardRenderResult {
    return {
      type: "attachment",
      contentType: "application/vnd.microsoft.card.adaptive",
      content: parsed.card,
      fallback: parsed.fallbackText,
    };
  },
};
