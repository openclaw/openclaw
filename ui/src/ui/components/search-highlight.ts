/**
 * Search Highlighting Utilities
 * Highlights matching text in search results
 */

import { html, type TemplateResult } from "lit";

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight matching text in a string
 * Returns a TemplateResult with <mark> tags around matches
 *
 * @param text The text to search in
 * @param query The search query to highlight
 * @param options Configuration options
 * @returns A Lit TemplateResult with highlighted matches
 */
export function highlightText(
  text: string,
  query: string,
  options: {
    /** Case-insensitive matching (default: true) */
    ignoreCase?: boolean;
    /** CSS class for the highlight mark (default: 'search-highlight') */
    className?: string;
    /** Maximum number of highlights to show (default: unlimited) */
    maxHighlights?: number;
  } = {}
): TemplateResult {
  const { ignoreCase = true, className = "search-highlight", maxHighlights } = options;

  // Return original text if no query
  if (!query || !query.trim()) {
    return html`${text}`;
  }

  const trimmedQuery = query.trim();
  const flags = ignoreCase ? "gi" : "g";
  const regex = new RegExp(`(${escapeRegExp(trimmedQuery)})`, flags);

  const parts = text.split(regex);
  let highlightCount = 0;

  const result = parts.map((part, index) => {
    // Odd indices are matches (due to capture group)
    const isMatch = index % 2 === 1;

    if (isMatch) {
      // Check if we've hit the max highlights limit
      if (maxHighlights !== undefined && highlightCount >= maxHighlights) {
        return part;
      }
      highlightCount++;
      return html`<mark class="${className}">${part}</mark>`;
    }

    return part;
  });

  return html`${result}`;
}

/**
 * Count the number of matches in text
 *
 * @param text The text to search in
 * @param query The search query to count
 * @param ignoreCase Case-insensitive matching (default: true)
 * @returns The number of matches found
 */
export function countMatches(
  text: string,
  query: string,
  ignoreCase = true
): number {
  if (!query || !query.trim()) return 0;

  const flags = ignoreCase ? "gi" : "g";
  const regex = new RegExp(escapeRegExp(query.trim()), flags);
  const matches = text.match(regex);

  return matches ? matches.length : 0;
}

/**
 * Check if text contains the search query
 *
 * @param text The text to search in
 * @param query The search query
 * @param ignoreCase Case-insensitive matching (default: true)
 * @returns True if the text contains the query
 */
export function textContains(
  text: string,
  query: string,
  ignoreCase = true
): boolean {
  if (!query || !query.trim()) return true;

  if (ignoreCase) {
    return text.toLowerCase().includes(query.trim().toLowerCase());
  }

  return text.includes(query.trim());
}

/**
 * Highlight multiple search terms
 *
 * @param text The text to search in
 * @param queries Array of search queries to highlight
 * @param options Configuration options
 * @returns A Lit TemplateResult with highlighted matches
 */
export function highlightMultiple(
  text: string,
  queries: string[],
  options: {
    ignoreCase?: boolean;
    className?: string;
  } = {}
): TemplateResult {
  const { ignoreCase = true, className = "search-highlight" } = options;

  // Filter out empty queries
  const validQueries = queries.filter((q) => q && q.trim());
  if (validQueries.length === 0) {
    return html`${text}`;
  }

  // Build regex pattern for all queries
  const pattern = validQueries.map((q) => escapeRegExp(q.trim())).join("|");
  const flags = ignoreCase ? "gi" : "g";
  const regex = new RegExp(`(${pattern})`, flags);

  const parts = text.split(regex);

  const result = parts.map((part, index) => {
    // Odd indices are matches
    const isMatch = index % 2 === 1;
    if (isMatch) {
      return html`<mark class="${className}">${part}</mark>`;
    }
    return part;
  });

  return html`${result}`;
}
