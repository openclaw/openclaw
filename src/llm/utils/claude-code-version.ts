// Resolves the installed Claude Code version at runtime for OAuth user-agent headers.
// Lazy-cached: only calls createRequire on first use, so non-OAuth Anthropic paths
// (API-key auth, non-claude-cli models) never trigger the lookup.
import { createRequire } from "node:module";

let cachedVersion: string | undefined;

/**
 * Reads the `version` field from `@anthropic-ai/claude-code/package.json`.
 * Caches the result after the first call. Throws if the package is not installed
 * or the version field is missing/invalid, because sending a fabricated
 * `claude-cli/*` user-agent with a stale or dummy version causes Anthropic's
 * API to reject OAuth bearer requests (#94716).
 */
export function resolveClaudeCodeVersion(moduleUrl: string): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const require = createRequire(moduleUrl);
  const pkg = require("@anthropic-ai/claude-code/package.json") as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      "@anthropic-ai/claude-code/package.json has no valid \"version\" field; " +
      "cannot determine the Claude Code version for the user-agent header",
    );
  }
  cachedVersion = pkg.version;
  return cachedVersion;
}

/** @internal Reset cache (for tests only). */
export function _resetClaudeCodeVersionCache(): void {
  cachedVersion = undefined;
}
