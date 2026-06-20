// Resolves the installed Claude Code CLI version for OAuth user-agent headers.
//
// The user-agent shipped on Anthropic OAuth requests is `claude-cli/<version>`,
// where `<version>` must match the installed @anthropic-ai/claude-code package.
// A stale version causes Anthropic OAuth to reject the bearer request, breaking
// Claude subscription-backed gateway and agent runs (see #94716).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type ClaudeCodeVersionResolver = () => string;

function createDefaultClaudeCodeVersionResolver(): ClaudeCodeVersionResolver {
  return () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@anthropic-ai/claude-code/package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof raw.version !== "string" || raw.version.length === 0) {
      throw new Error(
        `@anthropic-ai/claude-code/package.json at ${pkgPath} is missing a valid "version" field`,
      );
    }
    return raw.version;
  };
}

let resolver = createDefaultClaudeCodeVersionResolver();

export function resolveClaudeCodeVersion(): string {
  const version = resolver();
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `Resolved Claude Code version is invalid: expected non-empty string, got ${typeof version}`,
    );
  }
  return version;
}

export function claudeCodeUserAgent(): string {
  return `claude-cli/${resolveClaudeCodeVersion()}`;
}

/** Replace the resolver. Intended for tests only. */
export function setClaudeCodeVersionResolverForTest(next: ClaudeCodeVersionResolver): void {
  resolver = next;
}

/** Restore the default resolver. Intended for tests only. */
export function resetClaudeCodeVersionResolverForTest(): void {
  resolver = createDefaultClaudeCodeVersionResolver();
}
