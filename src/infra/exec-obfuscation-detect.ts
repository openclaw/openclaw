/**
 * Detects obfuscated or encoded commands that could bypass allowlist-based
 * security filters.
 *
 * Addresses: https://github.com/openclaw/openclaw/issues/8592
 *
 * When a command is piped through an encoding/decoding step, the allowlist
 * only sees the literal binary names (e.g. `echo`, `base64`, `sh`) which may
 * all individually appear benign. The decoded payload — which is the actual
 * command that will execute — is never inspected.
 *
 * This module detects common obfuscation patterns and flags them so the exec
 * tool can require explicit user approval regardless of allowlist status.
 */

export type ObfuscationDetection = {
  /** Whether any obfuscation pattern was detected. */
  detected: boolean;
  /** Human-readable descriptions of each matched pattern. */
  reasons: string[];
  /** The pattern identifiers that matched (for logging/metrics). */
  matchedPatterns: string[];
};

type ObfuscationPattern = {
  /** Unique identifier for this pattern. */
  id: string;
  /** Human-readable description shown to the user. */
  description: string;
  /** Regex to test against the command string. */
  regex: RegExp;
};

/**
 * Patterns that detect common encoding/obfuscation techniques used to
 * smuggle commands past pattern-based filters.
 *
 * Each pattern targets a specific technique documented in the threat model.
 * False-positive risk is minimized by requiring the decode + execute combination
 * (e.g. `base64 -d` alone is fine; `base64 -d | sh` is flagged).
 */
const OBFUSCATION_PATTERNS: ObfuscationPattern[] = [
  // --- Decode-to-execute pipelines ---
  // Catches: echo ... | base64 -d | sh, base64 --decode | bash, etc.
  {
    id: "base64-pipe-exec",
    description: "Base64 decode piped to shell execution",
    regex: /base64\s+(?:-d|--decode)\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  // Catches: echo ... | xxd -r -p | sh
  {
    id: "hex-pipe-exec",
    description: "Hex decode (xxd) piped to shell execution",
    regex: /xxd\s+-r\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  // Catches: printf '\x63\x61\x74' | sh
  {
    id: "printf-pipe-exec",
    description: "printf with escape sequences piped to shell execution",
    regex: /printf\s+.*\\x[0-9a-f]{2}.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },

  // --- Decode-to-eval ---
  // Catches: eval $(echo ... | base64 -d), eval "$(base64 -d ...)"
  {
    id: "eval-decode",
    description: "eval with encoded/decoded input",
    regex: /eval\s+.*(?:base64|xxd|printf|decode)/i,
  },

  // --- Standalone dangerous decode patterns ---
  // base64 -d piped to sh/bash (without the full pipeline visible)
  {
    id: "base64-decode-to-shell",
    description: "Base64 decode piped to shell",
    regex: /\|\s*base64\s+(?:-d|--decode)\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },

  // --- Generic pipe-to-shell ---
  // Catches: ... | sh, ... | bash (any content piped to a shell interpreter)
  // This is intentionally broad — piping arbitrary content to sh is inherently risky.
  {
    id: "pipe-to-shell",
    description: "Content piped directly to shell interpreter",
    regex: /\|\s*(?:sh|bash|zsh|dash|ksh|fish)\s*$/im,
  },

  // --- Octal/hex escape abuse in bash ---
  // Catches: $'\143\141\164' (octal escapes to build command strings)
  {
    id: "octal-escape",
    description: "Bash octal escape sequences (potential command obfuscation)",
    regex: /\$'(?:[^']*\\[0-7]{3}){2,}/,
  },

  // --- Hex escape abuse in bash ---
  // Catches: $'\x63\x61\x74' (hex escapes to build command strings)
  {
    id: "hex-escape",
    description: "Bash hex escape sequences (potential command obfuscation)",
    regex: /\$'(?:[^']*\\x[0-9a-fA-F]{2}){2,}/,
  },

  // --- python/perl/ruby one-liner execution ---
  // Catches: python3 -c "import os; os.system('...')" piped or with encoded payloads
  {
    id: "python-exec-encoded",
    description: "Python/Perl/Ruby with base64 or encoded execution",
    regex: /(?:python[23]?|perl|ruby)\s+-[ec]\s+.*(?:base64|b64decode|decode|exec|system|eval)/i,
  },

  // --- curl/wget piped to shell ---
  // Catches: curl ... | sh, wget ... -O - | bash
  {
    id: "curl-pipe-shell",
    description: "Remote content (curl/wget) piped to shell execution",
    regex: /(?:curl|wget)\s+.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },

  // --- Variable-based obfuscation with execution ---
  // Catches: a=cat;b=/etc/passwd;$a $b (variable expansion to hide commands)
  // Only flag when there are multiple single-char variable assignments followed by expansion
  {
    id: "var-expansion-obfuscation",
    description: "Variable assignment chain with expansion (potential obfuscation)",
    regex: /(?:[a-zA-Z_]\w{0,2}=\S+\s*;\s*){2,}.*\$(?:[a-zA-Z_]|\{[a-zA-Z_])/,
  },
];

/**
 * Commands or patterns that are commonly used in legitimate workflows and
 * should suppress specific obfuscation detections to reduce false positives.
 */
const FALSE_POSITIVE_SUPPRESSIONS: Array<{
  /** Pattern ids to suppress when this exemption matches. */
  suppresses: string[];
  /** Regex that identifies the legitimate usage. */
  regex: RegExp;
}> = [
  // Homebrew install script is a well-known curl|bash pattern.
  // Regexes require the known-good domain to appear as the URL host (immediately
  // after https?://) to prevent piggybacking via query parameters or path segments.
  {
    suppresses: ["curl-pipe-shell"],
    regex: /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/Homebrew|brew\.sh)\b/i,
  },
  // nvm, rustup, and other common installer scripts
  {
    suppresses: ["curl-pipe-shell"],
    regex:
      /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/nvm-sh\/nvm|sh\.rustup\.rs|get\.docker\.com|install\.python-poetry\.org)\b/i,
  },
  // Node.js package manager install scripts
  {
    suppresses: ["curl-pipe-shell"],
    regex: /curl\s+.*https?:\/\/(?:get\.pnpm\.io|bun\.sh\/install)\b/i,
  },
];

/**
 * Analyze a shell command string for obfuscation patterns.
 *
 * This function is designed to run BEFORE allowlist evaluation. When obfuscation
 * is detected, the exec tool should require explicit user approval regardless of
 * whether the command would otherwise pass the allowlist.
 */
export function detectCommandObfuscation(command: string): ObfuscationDetection {
  if (!command || !command.trim()) {
    return { detected: false, reasons: [], matchedPatterns: [] };
  }

  const reasons: string[] = [];
  const matchedPatterns: string[] = [];

  for (const pattern of OBFUSCATION_PATTERNS) {
    if (!pattern.regex.test(command)) {
      continue;
    }

    // Check if this match is suppressed by a known-good pattern.
    // Only allow suppression when the command contains a single URL — multiple
    // URLs could piggyback a known-good domain alongside a malicious one.
    const urlCount = (command.match(/https?:\/\/\S+/g) ?? []).length;
    const suppressed =
      urlCount <= 1 &&
      FALSE_POSITIVE_SUPPRESSIONS.some(
        (exemption) => exemption.suppresses.includes(pattern.id) && exemption.regex.test(command),
      );

    if (suppressed) {
      continue;
    }

    matchedPatterns.push(pattern.id);
    reasons.push(pattern.description);
  }

  return {
    detected: matchedPatterns.length > 0,
    reasons,
    matchedPatterns,
  };
}
