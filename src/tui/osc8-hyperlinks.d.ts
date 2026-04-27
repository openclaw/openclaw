/** Wrap text with an OSC 8 terminal hyperlink. */
export declare function wrapOsc8(url: string, text: string): string;
/**
 * Extract all unique URLs from raw markdown text.
 * Finds both bare URLs and markdown link hrefs [text](url).
 */
export declare function extractUrls(markdown: string): string[];
/**
 * Add OSC 8 hyperlinks to rendered lines using a pre-extracted URL list.
 *
 * For each line, finds URL-like substrings in the visible text, matches them
 * against known URLs, and wraps each fragment with OSC 8 escape sequences.
 * Handles URLs broken across multiple lines by pi-tui's word wrapping.
 */
export declare function addOsc8Hyperlinks(lines: string[], urls: string[]): string[];
