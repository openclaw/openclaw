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
  /** Stable card identifier extracted from the tool result metadata or card top-level $cardId. */
  cardId?: string;
  /** Preview image URL extracted from the tool result metadata or card top-level $previewUrl. */
  previewUrl?: string;
}

const CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;
const DATA_RE = /<!--adaptive-card-data-->([\s\S]*?)<!--\/adaptive-card-data-->/;
const META_RE = /<!--adaptive-card-meta-->([\s\S]*?)<!--\/adaptive-card-meta-->/;
const MARKERS_RE =
  /<!--adaptive-card-->[\s\S]*?<!--\/adaptive-card-->|<!--adaptive-card-data-->[\s\S]*?<!--\/adaptive-card-data-->|<!--adaptive-card-meta-->[\s\S]*?<!--\/adaptive-card-meta-->/g;

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

  // Extract cardId/previewUrl from meta marker or card top-level properties
  let cardId: string | undefined;
  let previewUrl: string | undefined;

  const metaMatch = META_RE.exec(text);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1].trim()) as Record<string, unknown>;
      if (typeof meta.cardId === "string") {
        cardId = meta.cardId;
      }
      if (typeof meta.previewUrl === "string") {
        previewUrl = meta.previewUrl;
      }
    } catch {
      // ignore malformed meta
    }
  }

  // Fall back to card top-level $cardId / $previewUrl (and strip them from the card)
  const cardAny = card as Record<string, unknown>;
  if (!cardId && typeof cardAny.$cardId === "string") {
    cardId = cardAny.$cardId;
  }
  if (!previewUrl && typeof cardAny.$previewUrl === "string") {
    previewUrl = cardAny.$previewUrl;
  }
  delete cardAny.$cardId;
  delete cardAny.$previewUrl;

  return {
    card,
    fallbackText,
    templateData,
    ...(cardId ? { cardId } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

/** Strip all adaptive card markers, returning only the fallback text. */
export function stripCardMarkers(text: string): string {
  return text.replace(MARKERS_RE, "").trim();
}
