/**
 * Normalizes port numbers from raw text or environment variables.
 * Ensures that leading zeros are handled correctly and not treated as octal (e.g., 3000 stays 3000).
 * Addresses #53935.
 */
export function parsePort(input: string | number): number {
    if (typeof input === "number") return input;
    
    // Explicitly use base 10 to avoid octal/hex misinterpretation of leading zeros
    const parsed = parseInt(input.trim(), 10);
    
    if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid port: ${input}`);
    }
    
    return parsed;
}
