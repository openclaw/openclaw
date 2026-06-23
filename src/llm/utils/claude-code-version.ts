// Resolves the installed Claude Code CLI version for OAuth user-agent headers.
//
// The user-agent header that ships on every Anthropic OAuth request is
// `claude-cli/<version>`, where `<version>` MUST match the installed
// @anthropic-ai/claude-code package. A stale version here causes Anthropic
// OAuth to reject the bearer request, breaking Claude subscription-backed
// gateway and agent runs.
//
// Resolution contract:
// - The active resolver is called once per `resolveClaudeCodeVersion()` call.
// - The result MUST be a non-empty string that begins with a digit (semver-ish).
//   Any other result (null, undefined, empty, non-digit-leading, throw) is
//   treated as a configuration error and surfaced as an exception.
// - This module never silently falls back to a stale version. A stale fallback
//   is the exact failure mode #94716 reports; re-emitting the rejected value
//   would preserve the production auth failure.
//
// The resolver is injectable via `__setClaudeCodeVersionResolver` so tests
// can run without depending on the host's global Node module graph. The
// default resolver reads `@anthropic-ai/claude-code/package.json` at call
// time — there is no module-load caching, so a re-resolution after package
// upgrade returns the new version without restarting the runtime.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Resolver type. Returns the resolved version, or `null` to signal "not
// resolvable from this source". Throws to signal a hard resolver failure
// (e.g. I/O error, malformed package.json). Both null and throw are
// treated as configuration errors by `resolveClaudeCodeVersion()`.
export type ClaudeCodeVersionResolver = () => string | null;

// Default resolver: walks the Node.js module resolution tree from the
// openclaw runtime to find `@anthropic-ai/claude-code/package.json`. The
// unscoped `claude` name was deliberately avoided because it can resolve
// to an unofficial npm package, which would feed a non-Anthropic-controlled
// version into an OAuth identity header.
export const defaultClaudeCodeVersionResolver: ClaudeCodeVersionResolver = () => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@anthropic-ai/claude-code/package.json");
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string") {
    throw new Error(
      `@anthropic-ai/claude-code/package.json has no "version" field at ${pkgPath}`,
    );
  }
  return raw.version;
};

let resolver: ClaudeCodeVersionResolver = defaultClaudeCodeVersionResolver;

export function __setClaudeCodeVersionResolver(next: ClaudeCodeVersionResolver): void {
  resolver = next;
}

export function __resetClaudeCodeVersionResolver(): void {
  resolver = defaultClaudeCodeVersionResolver;
}

// Returns the validated Claude Code version. Calls the active resolver,
// guards against throws, and validates the result is a digit-leading
// non-empty string. Any failure surfaces as an exception with the exact
// cause — never a stale fallback.
//
// Per #94716 review (ClawSweeper P1, 2026-06-19): a silent fallback to
// the rejected `2.1.75` value preserves the production auth failure.
// The runtime must surface the configuration error instead.
export function resolveClaudeCodeVersion(): string {
  let result: string | null;
  try {
    result = resolver();
  } catch (cause) {
    throw new Error(
      "Failed to resolve Claude Code version via the active resolver. " +
        "Install @anthropic-ai/claude-code or configure a custom resolver.",
      { cause },
    );
  }
  if (typeof result !== "string" || result.length === 0 || !/^\d/.test(result)) {
    throw new Error(
      `Claude Code version resolver returned an invalid value: ${JSON.stringify(result)}. ` +
        "Expected a digit-leading non-empty semver-ish string.",
    );
  }
  return result;
}

// Diagnostic accessor for the OAuth header value. Computed from the active
// resolver (not a frozen module-load constant), so a test that swaps the
// resolver before calling this function sees the new header.
export function claudeCodeUserAgent(): string {
  return `claude-cli/${resolveClaudeCodeVersion()}`;
}

