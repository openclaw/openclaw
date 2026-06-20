// Resolves the installed Claude Code CLI version for OAuth user-agent headers.
//
// The user-agent shipped on Anthropic OAuth requests is `claude-cli/<version>`,
// where `<version>` must match the installed Claude Code CLI. A stale version
// causes Anthropic OAuth to reject the bearer request, breaking Claude
// subscription-backed gateway and agent runs (see #94716).
//
// Resolution contract:
// - The active resolver is called once per `resolveClaudeCodeVersion()` call.
// - The result must be a non-empty, digit-leading string. Anything else
//   (empty, non-string, non-digit-leading, or a thrown resolver) surfaces as a
//   configuration error.
// - This module never silently falls back to a stale version. A stale fallback
//   is the exact failure mode #94716 reports; re-emitting the rejected value
//   would preserve the production auth failure.
//
// The resolver is injectable via `setClaudeCodeVersionResolverForTest` so tests
// can run without a real Claude CLI install.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type ClaudeCodeVersionResolver = () => string;

const CLAUDE_CODE_CLI_COMMAND = "claude";
const CLAUDE_CODE_CLI_VERSION_FLAG = "--version";
const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";

function extractLeadingSemver(raw: string): string | null {
  const match = /^\s*(\d+\.\d+\.\d+[^\s]*)/.exec(raw);
  return match?.[1] ?? null;
}

function resolveClaudeCodeVersionFromCli(): string {
  const raw = execFileSync(CLAUDE_CODE_CLI_COMMAND, [CLAUDE_CODE_CLI_VERSION_FLAG], {
    encoding: "utf8",
    timeout: 2000,
  });
  const version = extractLeadingSemver(raw);
  if (!version) {
    throw new Error(
      `Could not parse a semver version from \`${CLAUDE_CODE_CLI_COMMAND} ${CLAUDE_CODE_CLI_VERSION_FLAG}\`: ${JSON.stringify(raw)}`,
    );
  }
  return version;
}

function resolveClaudeCodeVersionFromPackageJson(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve(`${CLAUDE_CODE_PACKAGE_NAME}/package.json`);
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new Error(
      `${CLAUDE_CODE_PACKAGE_NAME}/package.json at ${pkgPath} is missing a valid "version" field`,
    );
  }
  return raw.version;
}

function defaultClaudeCodeVersionResolver(): string {
  try {
    return resolveClaudeCodeVersionFromCli();
  } catch {
    // A working `claude` binary is the supported install source. If it is not
    // on PATH, fall back to the package metadata in case OpenClaw is running
    // inside the same Node module graph as a dependency install.
    return resolveClaudeCodeVersionFromPackageJson();
  }
}

let resolver: ClaudeCodeVersionResolver = defaultClaudeCodeVersionResolver;

export function resolveClaudeCodeVersion(): string {
  const version = resolver();
  if (typeof version !== "string" || version.length === 0 || !/^\d/.test(version)) {
    throw new Error(
      `Resolved Claude Code version is invalid: expected a digit-leading non-empty string, got ${JSON.stringify(version)}`,
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
  resolver = defaultClaudeCodeVersionResolver;
}

/** Visible for tests: parse a `claude --version` style output into a semver. */
export function extractClaudeCodeCliVersionForTest(raw: string): string | null {
  return extractLeadingSemver(raw);
}
