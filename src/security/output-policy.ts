/**
 * Output Content Security Policy (CSP) rules.
 *
 * Filters agent reply text before delivery, stripping disallowed content
 * patterns (URLs, file paths, code blocks, system info, API keys, internal IPs)
 * and reporting violations for security logging.
 */

export type OutputCspRuleId =
  | "no-external-urls"
  | "no-file-paths"
  | "no-code-blocks"
  | "no-system-info"
  | "no-api-keys"
  | "no-internal-ips";

export type OutputCspRule = {
  id: OutputCspRuleId;
  detect: (text: string) => { matched: boolean; matches: string[] };
  redact: (text: string) => string;
};

export type OutputCspConfig = {
  defaultRules?: OutputCspRuleId[];
  channels?: Record<string, { rules?: OutputCspRuleId[] }>;
};

export type OutputCspResult = {
  text: string;
  strippedRules: Array<{ ruleId: OutputCspRuleId; matches: string[] }>;
};

// --- Rule implementations ---

/** Matches http(s) URLs excluding loopback and RFC 1918 addresses. */
const EXTERNAL_URL_RE =
  /https?:\/\/(?!(?:127\.0\.0\.1|localhost|\[?::1\]?|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?:[:/\s]|$))[^\s)>\]]+/gi;

/** Matches Unix absolute paths to common system directories and Windows drive paths. */
const FILE_PATH_RE =
  /(?:\/(?:home|Users|tmp|var|etc|opt|usr|root|mnt|media|srv)\/[^\s,;)>"']+|[A-Z]:\\[^\s,;)>"']+)/g;

/** Matches fenced code blocks (with or without language tags). */
const CODE_BLOCK_RE = /```[\s\S]*?```/g;

/** Matches common system info patterns. */
const SYSTEM_INFO_RE =
  /(?:Linux\s+\S+\s+\d+\.\d+\.\d+[^\n]*|Darwin\s+Kernel\s+Version[^\n]*|(?:^|\n)[A-Z_]{2,}=[^\n]+(?:\n[A-Z_]{2,}=[^\n]+){2,})/g;

/** Matches common API key patterns. */
const API_KEY_RE =
  /(?:sk-[a-zA-Z0-9]{20,}|pk_(?:live|test)_[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*\S{10,}|Bearer\s+[a-zA-Z0-9._\-]{20,}|AKIA[A-Z0-9]{16})/gi;

/** Matches RFC 1918 internal IPs standalone (not inside URLs). */
const INTERNAL_IP_RE =
  /(?<!\w)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?!\w)/g;

function makeRule(id: OutputCspRuleId, pattern: RegExp, replacement: string): OutputCspRule {
  return {
    id,
    detect(text: string) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      const matches = text.match(pattern) ?? [];
      return { matched: matches.length > 0, matches };
    },
    redact(text: string) {
      pattern.lastIndex = 0;
      return text.replace(pattern, replacement);
    },
  };
}

const RULES = new Map<OutputCspRuleId, OutputCspRule>([
  ["no-external-urls", makeRule("no-external-urls", EXTERNAL_URL_RE, "[URL redacted]")],
  ["no-file-paths", makeRule("no-file-paths", FILE_PATH_RE, "[path redacted]")],
  ["no-code-blocks", makeRule("no-code-blocks", CODE_BLOCK_RE, "[code block redacted]")],
  ["no-system-info", makeRule("no-system-info", SYSTEM_INFO_RE, "[system info redacted]")],
  ["no-api-keys", makeRule("no-api-keys", API_KEY_RE, "[key redacted]")],
  ["no-internal-ips", makeRule("no-internal-ips", INTERNAL_IP_RE, "[IP redacted]")],
]);

/**
 * Apply output CSP rules to text, redacting matches and collecting violations.
 */
export function applyOutputCsp(text: string, rules: OutputCspRuleId[]): OutputCspResult {
  let current = text;
  const strippedRules: OutputCspResult["strippedRules"] = [];

  for (const ruleId of rules) {
    const rule = RULES.get(ruleId);
    if (!rule) continue;

    const detection = rule.detect(current);
    if (detection.matched) {
      strippedRules.push({ ruleId, matches: detection.matches });
      current = rule.redact(current);
    }
  }

  return { text: current, strippedRules };
}

/**
 * Resolve the effective output CSP rules for a channel.
 *
 * Looks up per-channel override first (case-insensitive), then falls back
 * to the configured default rules, and finally to an empty array.
 */
export function resolveChannelOutputRules(
  channel: string,
  config: OutputCspConfig,
): OutputCspRuleId[] {
  const channelOverride = config.channels?.[channel.toLowerCase()]?.rules;
  if (channelOverride) {
    return channelOverride;
  }
  return config.defaultRules ?? [];
}
