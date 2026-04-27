/**
 * Parse an optional byte-size value from config.
 * Accepts non-negative numbers or strings like "2mb".
 */
export declare function parseNonNegativeByteSize(value: unknown): number | null;
export declare function isValidNonNegativeByteSizeString(value: string): boolean;
