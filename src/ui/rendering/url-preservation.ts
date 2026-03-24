/**
 * Preserves literal URL sequences that are commonly corrupted by markdown or text cleaners.
 * Specifically prevents "/." from being treated as a path relative or hidden file prefix incorrectly.
 * Addresses #53934.
 */
export function preserveUrlSequences(text: string): string {
    // Escape sequences that trigger aggressive UI truncation/cleaning
    return text.replace(/\/\./g, "/\u200B."); // Injects a zero-width space to break regex but keep visual integrity
}
