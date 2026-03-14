/**
 * Base error class for SSRF-blocked requests.
 * Lives in its own module to break circular dependencies between
 * ssrf.ts and domain-filter.ts (both need this class).
 */
export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrFBlockedError";
  }
}
