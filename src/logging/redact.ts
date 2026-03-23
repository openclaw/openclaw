import os from "node:os";
import type { OpenClawConfig } from "../config/config.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { replacePatternBounded } from "./redact-bounded.js";

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);

export type RedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments.
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
  // JSON fields.
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
  // CLI flags.
  String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
  // Authorization headers.
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  // Common token prefixes.
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
  String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
  String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
  String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
  // Telegram Bot API URLs embed the token as `/bot<token>/...` (no word-boundary before digits).
  String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
  String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
];

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: string[];
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: string): RegExp | null {
  if (!raw.trim()) {
    return null;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    return compileSafeRegex(match[1], flags);
  }
  return compileSafeRegex(raw, "gi");
}

function resolvePatterns(value?: string[]): RegExp[] {
  const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
  return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
  const end = token.slice(-DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const token =
    groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
  const masked = maskToken(token);
  if (token === match) {
    return masked;
  }
  return match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
  let next = text;
  for (const pattern of patterns) {
    next = replacePatternBounded(next, pattern, (...args: string[]) =>
      redactMatch(args[0], args.slice(1, args.length - 2)),
    );
  }
  return next;
}

function resolveConfigRedaction(): RedactOptions {
  let cfg: OpenClawConfig["logging"] | undefined;
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    cfg = loaded?.loadConfig?.().logging;
  } catch {
    cfg = undefined;
  }
  return {
    mode: normalizeMode(cfg?.redactSensitive),
    patterns: cfg?.redactPatterns,
  };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const resolved = options ?? resolveConfigRedaction();
  if (normalizeMode(resolved.mode) === "off") {
    return text;
  }
  const patterns = resolvePatterns(resolved.patterns);
  if (!patterns.length) {
    return text;
  }
  return redactText(text, patterns);
}

export function redactToolDetail(detail: string): string {
  const resolved = resolveConfigRedaction();
  if (normalizeMode(resolved.mode) !== "tools") {
    return detail;
  }
  return redactSensitiveText(detail, resolved);
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

/**
 * Returns runtime-derived redact patterns for the current OS user.
 * These are built once per process from os.userInfo() and cover:
 *   - The current username appearing in paths (e.g. /Users/alice/ → /Users/<redacted>/)
 *   - macOS-style home paths  (/Users/<username>)
 *   - Linux-style home paths  (/home/<username>)
 *   - Agent workspace paths that embed the username
 *
 * Returns an empty array if os.userInfo() is unavailable (e.g. inside a
 * container where the uid has no passwd entry).
 */
export function getSystemRedactPatterns(): string[] {
  let username: string;
  let homedir: string;
  try {
    const info = os.userInfo();
    username = info.username;
    homedir = info.homedir;
  } catch {
    return [];
  }

  if (!username || !homedir) {
    return [];
  }

  // Escape special regex chars in username and homedir.
  const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedHome = homedir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return [
    // macOS-style: /Users/<username>/...  →  /Users/<redacted>/...
    String.raw`(/Users/)${escapedUser}(/|$)`,
    // Linux-style: /home/<username>/...  →  /home/<redacted>/...
    String.raw`(/home/)${escapedUser}(/|$)`,
    // Full homedir prefix (catches any OS layout)
    String.raw`${escapedHome}(/|$)`,
    // Agent workspace paths that embed the username (e.g. workspaces/alice/...)
    String.raw`(workspaces/)${escapedUser}(/|$)`,
    // Bare username word (last-resort; only when it appears as a path segment)
    String.raw`(^|[/\s])${escapedUser}(/|$)`,
  ];
}

/**
 * Replacement label used when a username or homedir path is redacted.
 * Exported so tests can assert the substitution text.
 */
export const REDACTED_PATH_LABEL = "<redacted>";

/**
 * Redacts the current user's username from a path-like string, replacing
 * matched path segments with `<redacted>`.  Intended for log lines that
 * contain absolute paths, workspace paths, or bare username references.
 *
 * Unlike the token patterns in DEFAULT_REDACT_PATTERNS (which use maskToken),
 * path segments are replaced wholesale with the label so the path remains
 * readable (e.g. `/Users/<redacted>/projects`).
 */
export function redactSystemPaths(text: string): string {
  if (!text) {
    return text;
  }
  let username: string;
  let homedir: string;
  try {
    const info = os.userInfo();
    username = info.username;
    homedir = info.homedir;
  } catch {
    return text;
  }

  if (!username || !homedir) {
    return text;
  }

  const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedHome = homedir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Replace the full homedir first (most specific), then the username in
  // well-known path prefixes, to avoid double-substitution.
  const steps: [RegExp, string][] = [
    // Full home directory path (e.g. /Users/alice → /Users/<redacted>)
    [compileSafeRegex(String.raw`${escapedHome}`, "g") as RegExp, `/Users/${REDACTED_PATH_LABEL}`],
    // macOS /Users/<username>
    [
      compileSafeRegex(String.raw`(/Users/)${escapedUser}(/|(?=$|\s))`, "g") as RegExp,
      `$1${REDACTED_PATH_LABEL}$2`,
    ],
    // Linux /home/<username>
    [
      compileSafeRegex(String.raw`(/home/)${escapedUser}(/|(?=$|\s))`, "g") as RegExp,
      `$1${REDACTED_PATH_LABEL}$2`,
    ],
    // workspaces/<username>/
    [
      compileSafeRegex(String.raw`(workspaces/)${escapedUser}(/|(?=$|\s))`, "g") as RegExp,
      `$1${REDACTED_PATH_LABEL}$2`,
    ],
  ];

  let result = text;
  for (const [re, replacement] of steps) {
    if (re) {
      result = result.replace(re, replacement);
    }
  }
  return result;
}
