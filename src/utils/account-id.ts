/**
 * Normalizes an account ID by trimming whitespace and handling empty values.
 *
 * @param value - The account ID string to normalize
 * @returns The trimmed account ID, or undefined if the input is not a string or is empty
 *
 * @example
 * normalizeAccountId("  user123  ") // returns "user123"
 * normalizeAccountId("") // returns undefined
 * normalizeAccountId(undefined) // returns undefined
 */
export function normalizeAccountId(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
