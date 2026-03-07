const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const TAG_RE = /(?:^|[^\w])@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;
const HEADING_RE = /^#{1,3}\s+(.+)$/gm;
const NON_ENTITY_TERMS = new Set([
  "note",
  "warning",
  "important",
  "todo",
  "fixme",
  "example",
  "tip",
  "info",
]);

function normalizeEntity(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function stripHeadingFormatting(text: string): string {
  return normalizeEntity(text.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/[*_`~>#]/g, " "));
}

function shouldSkipEntity(entity: string): boolean {
  return NON_ENTITY_TERMS.has(entity.toLowerCase());
}

function pushEntity(list: string[], seen: Set<string>, value: string): void {
  const normalized = normalizeEntity(value);
  if (!normalized || shouldSkipEntity(normalized)) {
    return;
  }
  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(normalized);
}

/**
 * Extract entities from markdown text.
 * Looks for: @tags, **Bold** proper nouns, ## Headings
 * Returns a deduplicated array of entity strings.
 */
export function extractEntities(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  const entities: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(TAG_RE)) {
    pushEntity(entities, seen, match[1] ?? "");
  }

  for (const match of text.matchAll(BOLD_RE)) {
    pushEntity(entities, seen, match[1] ?? "");
  }

  for (const match of text.matchAll(HEADING_RE)) {
    pushEntity(entities, seen, stripHeadingFormatting(match[1] ?? ""));
  }

  return entities;
}

/**
 * Check if a chunk's entities list matches a query entity.
 * Case-insensitive partial match.
 */
export function entityMatches(entities: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return entities.some((entity) => entity.toLowerCase().includes(needle));
}
