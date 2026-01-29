/**
 * SECURITY: Dangerous Command Detection
 *
 * Blocks commands that are inherently dangerous regardless of allowlist status.
 * These patterns are blocked at the lowest level before any execution.
 */

export interface DangerousCommandMatch {
  pattern: string;
  reason: string;
  severity: "critical" | "high" | "medium";
}

// Critical: Commands that can cause catastrophic damage
const CRITICAL_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?[\/~]\s*$/i,
    reason: "Recursive delete of root or home directory",
  },
  {
    regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]\s*$/i,
    reason: "Recursive delete of root or home directory",
  },
  {
    regex: /\brm\s+-rf\s+\/(?!\w)/i,
    reason: "Recursive forced delete from root",
  },
  {
    regex: /\brm\s+-fr\s+\/(?!\w)/i,
    reason: "Recursive forced delete from root",
  },
  {
    regex: />\s*\/dev\/sd[a-z]/i,
    reason: "Direct write to block device",
  },
  {
    regex: /\bdd\s+.*\bof=\/dev\/sd[a-z]/i,
    reason: "Direct write to block device with dd",
  },
  {
    regex: /\bmkfs\b/i,
    reason: "Filesystem format command",
  },
  {
    regex: /\b:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Fork bomb detected",
  },
];

// High: Commands that can compromise security or cause significant damage
const HIGH_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\bcurl\s+.*\|\s*(ba)?sh\b/i,
    reason: "Piping remote content directly to shell",
  },
  {
    regex: /\bwget\s+.*\|\s*(ba)?sh\b/i,
    reason: "Piping remote content directly to shell",
  },
  {
    regex: /\bcurl\s+.*\|\s*sudo\b/i,
    reason: "Piping remote content to sudo",
  },
  {
    regex: /\bwget\s+.*\|\s*sudo\b/i,
    reason: "Piping remote content to sudo",
  },
  {
    regex: /\beval\s+.*\$\(curl\b/i,
    reason: "Eval of remote content",
  },
  {
    regex: /\beval\s+.*\$\(wget\b/i,
    reason: "Eval of remote content",
  },
  {
    regex: /\bgit\s+push\s+.*--force\b/i,
    reason: "Force push can destroy remote history",
  },
  {
    regex: /\bgit\s+push\s+-f\b/i,
    reason: "Force push can destroy remote history",
  },
  {
    regex: /\bchmod\s+(-[a-zA-Z]*\s+)?777\s+\//i,
    reason: "Setting world-writable permissions on system paths",
  },
  {
    regex: /\bchown\s+.*\s+\/(?:etc|usr|bin|sbin|lib|var)\b/i,
    reason: "Changing ownership of system directories",
  },
  {
    regex: />\s*\/etc\//i,
    reason: "Direct write to /etc",
  },
  {
    regex: /\bsudo\s+rm\b/i,
    reason: "Elevated delete command",
  },
  {
    regex: /\|\s*rm\b/i,
    reason: "Piping to rm command",
  },
  {
    regex: /\bxargs\s+.*\brm\b/i,
    reason: "Using xargs with rm",
  },
];

// Medium: Commands that warrant caution but may have legitimate uses
const MEDIUM_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\brm\s+-rf?\b/i,
    reason: "Recursive delete (verify target carefully)",
  },
  {
    regex: /\bgit\s+reset\s+--hard\b/i,
    reason: "Hard reset discards uncommitted changes",
  },
  {
    regex: /\bgit\s+clean\s+-fd/i,
    reason: "Clean removes untracked files",
  },
  {
    regex: /\bkillall\b/i,
    reason: "Kills all processes matching name",
  },
  {
    regex: /\bpkill\s+-9\b/i,
    reason: "Force kills processes",
  },
  {
    regex: /\bshutdown\b/i,
    reason: "System shutdown command",
  },
  {
    regex: /\breboot\b/i,
    reason: "System reboot command",
  },
  {
    regex: />\s*\/dev\/null\s*2>&1\s*&/i,
    reason: "Background process with suppressed output",
  },
];

/**
 * Check if a command matches any dangerous patterns.
 * Returns the match details if dangerous, null if safe.
 *
 * @param command The shell command to check
 * @param blockLevel Minimum severity to block: "critical" blocks only critical,
 *                   "high" blocks critical+high, "medium" blocks all
 */
export function detectDangerousCommand(
  command: string,
  blockLevel: "critical" | "high" | "medium" = "high"
): DangerousCommandMatch | null {
  const normalized = command.trim();

  // Always check critical patterns
  for (const { regex, reason } of CRITICAL_PATTERNS) {
    if (regex.test(normalized)) {
      return { pattern: regex.source, reason, severity: "critical" };
    }
  }

  // Check high patterns if blockLevel is high or medium
  if (blockLevel === "high" || blockLevel === "medium") {
    for (const { regex, reason } of HIGH_PATTERNS) {
      if (regex.test(normalized)) {
        return { pattern: regex.source, reason, severity: "high" };
      }
    }
  }

  // Check medium patterns only if blockLevel is medium
  if (blockLevel === "medium") {
    for (const { regex, reason } of MEDIUM_PATTERNS) {
      if (regex.test(normalized)) {
        return { pattern: regex.source, reason, severity: "medium" };
      }
    }
  }

  return null;
}

/**
 * Format a user-friendly error message for a blocked command.
 */
export function formatDangerousCommandError(match: DangerousCommandMatch): string {
  return (
    `Command blocked (${match.severity}): ${match.reason}. ` +
    "This command pattern is restricted for security. " +
    "If you need to perform this action, do it manually outside of the agent."
  );
}
