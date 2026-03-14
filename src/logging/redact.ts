import type { OpenClawConfig } from "../config/config.js";
import { resolveCustomRulesPath } from "../privacy/custom-rules.js";
import { PrivacyDetector } from "../privacy/detector.js";
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

type ResolvedConfig = {
  redactOptions: RedactOptions;
  privacyEnabled: boolean;
  privacyRules: string | undefined;
};

function resolveConfigRedaction(): ResolvedConfig {
  let loggingCfg: OpenClawConfig["logging"] | undefined;
  let privacyCfg: OpenClawConfig["privacy"] | undefined;
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    const full = loaded?.loadConfig?.();
    loggingCfg = full?.logging;
    privacyCfg = full?.privacy;
  } catch {
    loggingCfg = undefined;
    privacyCfg = undefined;
  }
  return {
    redactOptions: {
      mode: normalizeMode(loggingCfg?.redactSensitive),
      patterns: loggingCfg?.redactPatterns,
    },
    // When privacy is not configured at all we treat it as enabled (safe default).
    privacyEnabled: privacyCfg?.enabled !== false,
    privacyRules: privacyCfg?.rules,
  };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const resolved = options ?? resolveConfigRedaction().redactOptions;
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
  if (normalizeMode(resolved.redactOptions.mode) !== "tools") {
    return detail;
  }
  return redactWithPrivacyFilter(
    detail,
    resolved.redactOptions,
    resolved.privacyEnabled,
    resolved.privacyRules,
  );
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

// Cache the last detector instance keyed by ruleset to avoid re-construction
// on every log line while still respecting user-configured rules.
let cachedDetector: PrivacyDetector | undefined;
let cachedDetectorRules: string | undefined;

function resolveDetectorRulesKey(rules: string): string {
  if (rules === "basic" || rules === "extended" || rules === "none") {
    return rules;
  }
  return resolveCustomRulesPath(rules);
}

type RedactionMatch = {
  start: number;
  end: number;
  content: string;
  riskLevel: "low" | "medium" | "high" | "critical";
};

/**
 * Enhanced redaction that combines the existing pattern-based redaction
 * with the privacy detection engine for broader coverage.
 *
 * Respects `privacy.enabled` — when false, only the pattern-based pass runs.
 * Respects `privacy.rules` — uses the configured ruleset instead of always
 * defaulting to "extended".
 */
export function redactWithPrivacyFilter(
  text: string,
  options?: RedactOptions,
  privacyEnabled = true,
  privacyRules: string | undefined = undefined,
): string {
  if (!text) {
    return text;
  }

  // First pass: existing pattern-based redaction.
  let result = redactSensitiveText(text, options);

  // Second pass: privacy detector for additional coverage.
  // Skip entirely when the user has opted out of privacy features.
  if (!privacyEnabled) {
    return result;
  }

  try {
    const rules = resolveDetectorRulesKey(privacyRules ?? "extended");
    // Re-create the detector only when the ruleset changes.
    if (!cachedDetector || cachedDetectorRules !== rules) {
      cachedDetector = new PrivacyDetector(rules);
      cachedDetectorRules = rules;
    }
    const detected = cachedDetector.detect(result);
    if (detected.hasPrivacyRisk) {
      // Apply mask-style redaction (not replacement) for log output.
      const selected = selectNonOverlappingMatches(detected.matches);
      const sorted = [...selected].toSorted((a, b) => b.start - a.start);
      for (const match of sorted) {
        const masked = maskToken(match.content);
        result = result.slice(0, match.start) + masked + result.slice(match.end);
      }
    }
  } catch {
    // Non-fatal: fall back to pattern-only redaction.
  }

  return result;
}

function selectNonOverlappingMatches(matches: RedactionMatch[]): RedactionMatch[] {
  const sorted = [...matches].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    const spanDiff = b.end - b.start - (a.end - a.start);
    if (spanDiff !== 0) {
      return spanDiff;
    }
    return riskRank(b.riskLevel) - riskRank(a.riskLevel);
  });

  const selected: RedactionMatch[] = [];
  let lastEnd = -1;
  for (const match of sorted) {
    if (match.start < lastEnd) {
      continue;
    }
    selected.push(match);
    lastEnd = match.end;
  }
  return selected;
}

function riskRank(level: "low" | "medium" | "high" | "critical"): number {
  switch (level) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}
