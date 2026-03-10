/**
 * Parse adaptive card markers embedded in reply text.
 *
 * The adaptive-cards extension embeds card JSON between HTML comment markers:
 *   <!--adaptive-card-->{ ... }<!--/adaptive-card-->
 *   <!--adaptive-card-data-->{ ... }<!--/adaptive-card-data-->
 *
 * Everything before the first marker is treated as fallback plain text.
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

const CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;
const DATA_RE = /<!--adaptive-card-data-->([\s\S]*?)<!--\/adaptive-card-data-->/;
const MARKERS_RE =
  /<!--adaptive-card-->[\s\S]*?<!--\/adaptive-card-->|<!--adaptive-card-data-->[\s\S]*?<!--\/adaptive-card-data-->/g;

/**
 * Attempt to parse adaptive card markers from message text.
 * Returns null when no card markers are present.
 */
export function parseAdaptiveCardMarkers(text: string): ParsedAdaptiveCard | null {
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

  if (card?.type !== "AdaptiveCard") {
    return null;
  }

  const fallbackText = text.slice(0, cardMatch.index).trim();

  const dataMatch = DATA_RE.exec(text);
  let templateData: unknown;
  if (dataMatch) {
    try {
      templateData = JSON.parse(dataMatch[1].trim());
    } catch {
      // ignore malformed template data
    }
  }

  return { card, fallbackText, templateData };
}

/** Strip all adaptive card markers, returning only the fallback text. */
export function stripCardMarkers(text: string): string {
  return text.replace(MARKERS_RE, "").trim();
}
