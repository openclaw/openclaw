// Guardrails for elevated=full exec mode.
// Blocks obviously destructive patterns that a prompt-injected agent could exploit
// when approval bypass is active.

type BlockedPattern = {
  pattern: RegExp;
  reason: string;
};

// Patterns that should never execute unattended on the host, even in elevated=full mode.
// These target unambiguously destructive operations — not general shell features.
const ELEVATED_BLOCKED_PATTERNS: BlockedPattern[] = [
  {
    pattern: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
    reason: "network fetch piped to shell execution",
  },
  {
    pattern: /\b(curl|wget)\b.*\|\s*(source|\\.)\b/i,
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+[/~]/,
    reason: "recursive forced deletion of root or home directory",
  },
  {
    pattern: /\bmkfs\b/,
    reason: "filesystem format command",
  },
  {
    pattern: /\bdd\b.*\bof\s*=\s*\/dev\//,
    reason: "raw disk write via dd",
  },
  {
    pattern: /\bbase64\b.*(-d|--decode).*\|\s*(ba)?sh\b/i,
    reason: "encoded payload piped to shell",
  },
  {
    pattern: /\bcat\b.*\/(\.openclaw|\.ssh)\b.*\|\s*(curl|wget|nc|netcat)\b/i,
  },
  {
    pattern: /(curl|wget|nc|netcat)\b.*\$\(cat\b.*\/(\.openclaw|\.ssh)\b/i,
    reason: "credential file exfiltration via command substitution",
  },
];

export type ElevatedGuardResult = {
  blocked: boolean;
  reason: string;
};

/**
 * Checks a command against destructive patterns that should be blocked
 * even when elevated=full bypasses normal approval flow.
 */
export function checkElevatedCommand(command: string): ElevatedGuardResult {
  for (const { pattern, reason } of ELEVATED_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false, reason: "" };
}
