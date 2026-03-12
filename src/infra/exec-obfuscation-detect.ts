/**
 * Detects obfuscated or encoded commands that could bypass allowlist-based
 * security filters.
 *
 * Addresses: https://github.com/openclaw/openclaw/issues/8592
 */

export type ObfuscationDetection = {
  detected: boolean;
  reasons: string[];
  matchedPatterns: string[];
};

type ObfuscationPattern = {
  id: string;
  description: string;
  regex: RegExp;
};

const INVISIBLE_UNICODE_CODE_POINTS = new Set<number>([
  0x00ad,
  0x034f,
  0x061c,
  0x115f,
  0x1160,
  0x17b4,
  0x17b5,
  0x180e,
  0x3164,
  0xfeff,
  0xffa0,
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060,
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x2065,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0x206a,
  0x206b,
  0x206c,
  0x206d,
  0x206e,
  0x206f,
  0xfe00,
  0xfe01,
  0xfe02,
  0xfe03,
  0xfe04,
  0xfe05,
  0xfe06,
  0xfe07,
  0xfe08,
  0xfe09,
  0xfe0a,
  0xfe0b,
  0xfe0c,
  0xfe0d,
  0xfe0e,
  0xfe0f,
  0xe0001,
  ...Array.from({ length: 95 }, (_unused, index) => 0xe0020 + index),
]);

function stripInvisibleUnicode(command: string): string {
  return Array.from(command)
    .filter((char) => !INVISIBLE_UNICODE_CODE_POINTS.has(char.codePointAt(0) ?? -1))
    .join("");
}

const OBFUSCATION_PATTERNS: ObfuscationPattern[] = [
  {
    id: "base64-pipe-exec",
    description: "Base64 decode piped to shell execution",
    regex: /base64\s+(?:-d|--decode)\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  {
    id: "hex-pipe-exec",
    description: "Hex decode (xxd) piped to shell execution",
    regex: /xxd\s+-r\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  {
    id: "printf-pipe-exec",
    description: "printf with escape sequences piped to shell execution",
    regex: /printf\s+.*\\x[0-9a-f]{2}.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  {
    id: "eval-decode",
    description: "eval with encoded/decoded input",
    regex: /eval\s+.*(?:base64|xxd|printf|decode)/i,
  },
  {
    id: "base64-decode-to-shell",
    description: "Base64 decode piped to shell",
    regex: /\|\s*base64\s+(?:-d|--decode)\b.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  {
    id: "pipe-to-shell",
    description: "Content piped directly to shell interpreter",
    regex: /\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b(?:\s+[^|;\n\r]+)?\s*$/im,
  },
  {
    id: "command-substitution-decode-exec",
    description: "Shell -c with command substitution decode/obfuscation",
    regex:
      /(?:sh|bash|zsh|dash|ksh|fish)\s+-c\s+["'][^"']*\$\([^)]*(?:base64\s+(?:-d|--decode)|xxd\s+-r|printf\s+.*\\x[0-9a-f]{2})[^)]*\)[^"']*["']/i,
  },
  {
    id: "process-substitution-remote-exec",
    description: "Shell process substitution from remote content",
    regex: /(?:sh|bash|zsh|dash|ksh|fish)\s+<\(\s*(?:curl|wget)\b/i,
  },
  {
    id: "source-process-substitution-remote",
    description: "source/. with process substitution from remote content",
    regex: /(?:^|[;&\s])(?:source|\.)\s+<\(\s*(?:curl|wget)\b/i,
  },
  {
    id: "shell-heredoc-exec",
    description: "Shell heredoc execution",
    regex: /(?:sh|bash|zsh|dash|ksh|fish)\s+<<-?\s*['"]?[a-zA-Z_][\w-]*['"]?/i,
  },
  {
    id: "octal-escape",
    description: "Bash octal escape sequences (potential command obfuscation)",
    regex: /\$'(?:[^']*\\[0-7]{3}){2,}/,
  },
  {
    id: "hex-escape",
    description: "Bash hex escape sequences (potential command obfuscation)",
    regex: /\$'(?:[^']*\\x[0-9a-fA-F]{2}){2,}/,
  },
  {
    id: "python-exec-encoded",
    description: "Python/Perl/Ruby with base64 or encoded execution",
    regex: /(?:python[23]?|perl|ruby)\s+-[ec]\s+.*(?:base64|b64decode|decode|exec|system|eval)/i,
  },
  {
    id: "curl-pipe-shell",
    description: "Remote content (curl/wget) piped to shell execution",
    regex: /(?:curl|wget)\s+.*\|\s*(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  },
  {
    id: "var-expansion-obfuscation",
    description: "Variable assignment chain with expansion (potential obfuscation)",
    regex: /(?:[a-zA-Z_]\w{0,2}=\S+\s*;\s*){2,}.*\$(?:[a-zA-Z_]|\{[a-zA-Z_])/,
  },
];

const FALSE_POSITIVE_SUPPRESSIONS: Array<{
  suppresses: string[];
  regex: RegExp;
}> = [
  {
    suppresses: ["curl-pipe-shell"],
    regex: /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/Homebrew|brew\.sh)\b/i,
  },
  {
    suppresses: ["curl-pipe-shell"],
    regex:
      /curl\s+.*https?:\/\/(?:raw\.githubusercontent\.com\/nvm-sh\/nvm|sh\.rustup\.rs|get\.docker\.com|install\.python-poetry\.org)\b/i,
  },
  {
    suppresses: ["curl-pipe-shell"],
    regex: /curl\s+.*https?:\/\/(?:get\.pnpm\.io|bun\.sh\/install)\b/i,
  },
];

export function detectCommandObfuscation(command: string): ObfuscationDetection {
  if (!command || !command.trim()) {
    return { detected: false, reasons: [], matchedPatterns: [] };
  }

  const normalizedCommand = stripInvisibleUnicode(command.normalize("NFKC"));

  const reasons: string[] = [];
  const matchedPatterns: string[] = [];

  for (const pattern of OBFUSCATION_PATTERNS) {
    if (!pattern.regex.test(normalizedCommand)) {
      continue;
    }

    const urlCount = (normalizedCommand.match(/https?:\/\/\S+/g) ?? []).length;
    const suppressed =
      urlCount <= 1 &&
      FALSE_POSITIVE_SUPPRESSIONS.some(
        (exemption) =>
          exemption.suppresses.includes(pattern.id) && exemption.regex.test(normalizedCommand),
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
