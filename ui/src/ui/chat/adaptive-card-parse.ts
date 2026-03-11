/**
 * Parse adaptive card markers embedded in assistant messages.
 *
 * Marker format (emitted by the adaptive-cards extension):
 *   <!--adaptive-card-->{ ... JSON ... }<!--/adaptive-card-->
 *   <!--adaptive-card-data-->{ ... JSON ... }<!--/adaptive-card-data-->
 */

export interface ParsedAdaptiveCard {
  card: {
    type: "AdaptiveCard";
    version: string;
    body: unknown[];
    actions?: unknown[];
  };
  fallbackText: string;
  templateData?: unknown;
}

const CARD_RE =
  /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;
const DATA_RE =
  /<!--adaptive-card-data-->([\s\S]*?)<!--\/adaptive-card-data-->/;
const STRIP_RE =
  /\s*<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->\s*/g;
const STRIP_DATA_RE =
  /\s*<!--adaptive-card-data-->([\s\S]*?)<!--\/adaptive-card-data-->\s*/g;

/**
 * Extract the first adaptive card (and optional template data) from a message.
 * Returns `null` when the text contains no card markers.
 */
export function parseAdaptiveCardMarkers(
  text: string,
): ParsedAdaptiveCard | null {
  const cardMatch = CARD_RE.exec(text);
  if (!cardMatch) {
    return null;
  }

  let card: ParsedAdaptiveCard["card"];
  try {
    card = JSON.parse(cardMatch[1].trim());
  } catch {
    return null;
  }

  if (card?.type !== "AdaptiveCard" || !Array.isArray(card.body)) {
    return null;
  }

  let templateData: unknown | undefined;
  const dataMatch = DATA_RE.exec(text);
  if (dataMatch) {
    try {
      templateData = JSON.parse(dataMatch[1].trim());
    } catch {
      // Ignore malformed template data — card still renders without it.
    }
  }

  const fallbackText = stripCardMarkers(text).trim();

  return { card, fallbackText, templateData };
}

/** Remove all card + data markers, returning only the surrounding prose. */
export function stripCardMarkers(text: string): string {
  return text
    .replace(STRIP_RE, "\n")
    .replace(STRIP_DATA_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
