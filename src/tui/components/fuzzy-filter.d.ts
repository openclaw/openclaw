/**
 * Shared fuzzy filtering utilities for select list components.
 */
/**
 * Check if position is at a word boundary.
 */
export declare function isWordBoundary(text: string, index: number): boolean;
/**
 * Find index where query matches at a word boundary in text.
 * Returns null if no match.
 */
export declare function findWordBoundaryIndex(text: string, query: string): number | null;
/**
 * Fuzzy match with pre-lowercased inputs (avoids toLowerCase on every keystroke).
 * Returns score (lower = better) or null if no match.
 */
export declare function fuzzyMatchLower(queryLower: string, textLower: string): number | null;
/**
 * Filter items using pre-lowercased searchTextLower field.
 * Supports space-separated tokens (all must match).
 */
export declare function fuzzyFilterLower<T extends {
    searchTextLower?: string;
}>(items: T[], queryLower: string): T[];
/**
 * Prepare items for fuzzy filtering by pre-computing lowercase search text.
 */
export declare function prepareSearchItems<T extends {
    label?: string;
    description?: string;
    searchText?: string;
}>(items: T[]): (T & {
    searchTextLower: string;
})[];
