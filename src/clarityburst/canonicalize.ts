/**
 * Canonicalization utilities for ClarityBurst gating.
 *
 * This module provides the single source of truth for operation and URL
 * canonicalization used in confirmation fingerprinting and router context.
 * All components that need canonical values (opHash8 computation, router
 * context, tests) MUST import from this module to ensure consistency.
 */

/**
 * Canonicalize an operation verb for consistent hashing and routing.
 * - Trims leading/trailing whitespace
 * - Converts to lowercase for case-insensitive matching
 *
 * This MUST be used by:
 * - wrapWithNetworkGating() before passing operation to router context
 * - computeNetworkOpHash8() for fingerprinting
 * - Tests that verify operation consistency
 *
 * @param op - The operation verb (e.g., "GET", "POST", "fetch")
 * @returns The canonicalized operation in lowercase with whitespace trimmed
 */
export function canonicalizeOperation(op: string): string {
  return op.trim().toLowerCase();
}

/**
 * Canonicalize a URL for consistent hashing (format-only).
 * - Trims leading/trailing whitespace only
 * - No decoding, no normalization beyond whitespace to avoid surprising hash drift
 *
 * @param url - The URL to canonicalize
 * @returns The canonicalized URL with whitespace trimmed
 */
export function canonicalizeUrl(url: string): string {
  return url.trim();
}
