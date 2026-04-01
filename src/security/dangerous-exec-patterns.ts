/**
 * Dangerous Execution Patterns - Detects potentially dangerous command patterns.
 *
 * Inspired by Claude Code's dangerousPatterns.ts implementation.
 * These patterns represent commands that can execute arbitrary code,
 * making allowlist rules like `python:*` or `npm run:*` extremely dangerous.
 *
 * Key insight: An allowlist rule like `Bash(python:*)` lets the model run
 * ANY Python code, completely bypassing security. These patterns should be
 * stripped when entering high-security modes.
 *
 * @see https://github.com/anthropics/claude-code - Reference implementation
 */

/**
 * Cross-platform code execution entry points.
 * These interpreters can execute arbitrary code passed as arguments.
 */
export const INTERPRETER_PATTERNS = [
  // Python
  "python",
  "python3",
  "python2",
  "python3.8",
  "python3.9",
  "python3.10",
  "python3.11",
  "python3.12",

  // Node.js / JavaScript
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",

  // Ruby
  "ruby",
  "irb",

  // Perl
  "perl",

  // PHP
  "php",

  // Lua
  "lua",
  "luajit",

  // Other interpreters
  "awk",
  "gawk",
  "nawk",
  "sed",
] as const;

/**
 * Package manager run commands.
 * These can execute arbitrary code via package scripts.
 */
export const PACKAGE_RUNNER_PATTERNS = [
  // npm
  "npx",
  "npm run",
  "npm exec",
  "npm x",

  // yarn
  "yarn run",
  "yarn exec",
  "yarn dlx",

  // pnpm
  "pnpm run",
  "pnpm exec",
  "pnpm dlx",

  // bun
  "bunx",
  "bun run",
  "bun x",

  // pip
  "pipx run",

  // cargo
  "cargo run",

  // go
  "go run",
] as const;

/**
 * Shell commands that can execute arbitrary code.
 */
export const SHELL_EXEC_PATTERNS = [
  // Shells
  "bash",
  "sh",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",

  // Shell execution commands
  "eval",
  "exec",
  "source",
  ".",

  // Environment manipulation that can execute code
  "env",
  "xargs",

  // Privilege escalation
  "sudo",
  "su",
  "doas",
  "pkexec",
] as const;

/**
 * Remote execution commands.
 */
export const REMOTE_EXEC_PATTERNS = [
  // SSH
  "ssh",
  "sshpass",

  // Container execution
  "docker exec",
  "docker run",
  "podman exec",
  "podman run",
  "kubectl exec",
  "kubectl run",

  // Remote shells
  "telnet",
  "rsh",
  "rexec",
] as const;

/**
 * Network tools that can be used for data exfiltration or downloading malicious code.
 */
export const NETWORK_TOOL_PATTERNS = [
  // Download/upload
  "curl",
  "wget",
  "fetch",

  // Git (can execute code via hooks)
  "git",

  // Cloud CLIs
  "aws",
  "gcloud",
  "gsutil",
  "az",
  "kubectl",

  // API tools
  "gh", // GitHub CLI - can create gists, push code
  "gh api",
] as const;

/**
 * All dangerous patterns combined.
 * An allowlist entry matching any of these with a wildcard (e.g., `python:*`)
 * is considered dangerous.
 */
export const ALL_DANGEROUS_PATTERNS = [
  ...INTERPRETER_PATTERNS,
  ...PACKAGE_RUNNER_PATTERNS,
  ...SHELL_EXEC_PATTERNS,
  ...REMOTE_EXEC_PATTERNS,
  ...NETWORK_TOOL_PATTERNS,
] as const;

/**
 * Patterns that are dangerous only in certain contexts.
 * These may be safe with specific, constrained arguments.
 */
export const CONTEXT_SENSITIVE_PATTERNS = [
  // git is dangerous for hooks but safe for basic operations
  "git clone",
  "git pull",
  "git push",
  "git fetch",

  // curl/wget are dangerous for piping to shell but safe for simple downloads
  "curl -o",
  "wget -O",
] as const;

export type DangerousPatternCategory =
  | "interpreter"
  | "package_runner"
  | "shell_exec"
  | "remote_exec"
  | "network_tool";

export type DangerousPatternMatch = {
  pattern: string;
  category: DangerousPatternCategory;
  reason: string;
  /** Severity: critical patterns should never be auto-allowed */
  severity: "critical" | "high" | "medium";
};

/**
 * Check if a command matches a dangerous pattern.
 */
export function matchesDangerousPattern(command: string): DangerousPatternMatch | null {
  const normalized = command.trim().toLowerCase();

  // Check interpreters (critical - can run arbitrary code)
  for (const pattern of INTERPRETER_PATTERNS) {
    if (normalized === pattern || normalized.startsWith(`${pattern} `)) {
      return {
        pattern,
        category: "interpreter",
        reason: `${pattern} can execute arbitrary code`,
        severity: "critical",
      };
    }
  }

  // Check package runners (critical - can run arbitrary scripts)
  for (const pattern of PACKAGE_RUNNER_PATTERNS) {
    if (normalized === pattern || normalized.startsWith(`${pattern} `)) {
      return {
        pattern,
        category: "package_runner",
        reason: `${pattern} can execute arbitrary package scripts`,
        severity: "critical",
      };
    }
  }

  // Check shell execution (critical)
  for (const pattern of SHELL_EXEC_PATTERNS) {
    if (normalized === pattern || normalized.startsWith(`${pattern} `)) {
      return {
        pattern,
        category: "shell_exec",
        reason: `${pattern} can execute arbitrary shell commands`,
        severity: "critical",
      };
    }
  }

  // Check remote execution (high - requires network access)
  for (const pattern of REMOTE_EXEC_PATTERNS) {
    if (normalized === pattern || normalized.startsWith(`${pattern} `)) {
      return {
        pattern,
        category: "remote_exec",
        reason: `${pattern} enables remote code execution`,
        severity: "high",
      };
    }
  }

  // Check network tools (medium - can be used safely but also for exfiltration)
  for (const pattern of NETWORK_TOOL_PATTERNS) {
    if (normalized === pattern || normalized.startsWith(`${pattern} `)) {
      return {
        pattern,
        category: "network_tool",
        reason: `${pattern} can access network resources`,
        severity: "medium",
      };
    }
  }

  return null;
}

/**
 * Check if an allowlist pattern is dangerous.
 * Patterns like `python:*` or `npm run:*` are dangerous because they
 * allow arbitrary code execution.
 */
export function isDangerousAllowlistPattern(pattern: string): {
  dangerous: boolean;
  match?: DangerousPatternMatch;
  reason?: string;
} {
  const normalized = pattern.trim().toLowerCase();

  // Wildcard patterns are more dangerous
  const isWildcard = normalized.endsWith(":*") || normalized.endsWith("*") || normalized.endsWith(" *");

  // Extract the base command from patterns like "python:*" or "npm run:*"
  let baseCommand = normalized;
  if (isWildcard) {
    baseCommand = normalized.replace(/:?\*$/, "").replace(/ \*$/, "").trim();
  }

  const match = matchesDangerousPattern(baseCommand);

  if (match) {
    // Wildcard patterns for dangerous commands are always dangerous
    if (isWildcard) {
      return {
        dangerous: true,
        match,
        reason: `Wildcard allowlist for ${match.pattern} enables arbitrary code execution`,
      };
    }

    // Non-wildcard patterns are still concerning but less severe
    if (match.severity === "critical") {
      return {
        dangerous: true,
        match,
        reason: `Allowlist entry for ${match.pattern} may enable code execution`,
      };
    }
  }

  return { dangerous: false };
}

/**
 * Filter out dangerous patterns from an allowlist.
 * Used when transitioning to a more secure mode.
 */
export function stripDangerousAllowlistPatterns(
  allowlist: string[],
  options?: {
    /** Only strip critical severity patterns */
    criticalOnly?: boolean;
    /** Callback for each stripped pattern */
    onStrip?: (pattern: string, reason: string) => void;
  },
): { filtered: string[]; stripped: string[] } {
  const filtered: string[] = [];
  const stripped: string[] = [];

  for (const pattern of allowlist) {
    const check = isDangerousAllowlistPattern(pattern);

    if (check.dangerous) {
      // In critical-only mode, only strip critical patterns
      if (options?.criticalOnly && check.match?.severity !== "critical") {
        filtered.push(pattern);
        continue;
      }

      stripped.push(pattern);
      options?.onStrip?.(pattern, check.reason ?? "Dangerous pattern");
    } else {
      filtered.push(pattern);
    }
  }

  return { filtered, stripped };
}

/**
 * Check if a command contains shell injection patterns.
 * This is a basic check for common injection patterns.
 */
export function hasShellInjectionPattern(command: string): {
  dangerous: boolean;
  patterns: string[];
} {
  const dangerousPatterns: string[] = [];

  // Command chaining
  if (/[;&|]/.test(command)) {
    dangerousPatterns.push("command_chaining");
  }

  // Subshell/command substitution
  if (/\$\(|\`/.test(command)) {
    dangerousPatterns.push("command_substitution");
  }

  // Redirection (potential file overwrite)
  if (/>/.test(command)) {
    dangerousPatterns.push("redirection");
  }

  // Process substitution
  if (/<\(|>\(/.test(command)) {
    dangerousPatterns.push("process_substitution");
  }

  // Pipe to shell
  if (/\|\s*(bash|sh|zsh|fish|eval|xargs)/.test(command)) {
    dangerousPatterns.push("pipe_to_shell");
  }

  // Download and execute
  if (/curl.*\|.*sh|wget.*\|.*sh|curl.*\|.*bash|wget.*\|.*bash/.test(command)) {
    dangerousPatterns.push("download_and_execute");
  }

  return {
    dangerous: dangerousPatterns.length > 0,
    patterns: dangerousPatterns,
  };
}

/**
 * Analyze command security for detailed reporting.
 */
export function analyzeCommandSecurity(command: string): {
  command: string;
  dangerousPattern: DangerousPatternMatch | null;
  injectionPatterns: string[];
  riskLevel: "critical" | "high" | "medium" | "low";
  summary: string;
} {
  const dangerousPattern = matchesDangerousPattern(command);
  const injection = hasShellInjectionPattern(command);

  let riskLevel: "critical" | "high" | "medium" | "low" = "low";
  const risks: string[] = [];

  if (dangerousPattern) {
    if (dangerousPattern.severity === "critical") {
      riskLevel = "critical";
    } else if (dangerousPattern.severity === "high" && riskLevel !== "critical") {
      riskLevel = "high";
    } else if (dangerousPattern.severity === "medium" && riskLevel === "low") {
      riskLevel = "medium";
    }
    risks.push(dangerousPattern.reason);
  }

  if (injection.dangerous) {
    if (injection.patterns.includes("download_and_execute")) {
      riskLevel = "critical";
    } else if (injection.patterns.includes("pipe_to_shell")) {
      riskLevel = riskLevel === "low" ? "high" : riskLevel;
    } else {
      riskLevel = riskLevel === "low" ? "medium" : riskLevel;
    }
    risks.push(`Shell patterns: ${injection.patterns.join(", ")}`);
  }

  return {
    command,
    dangerousPattern,
    injectionPatterns: injection.patterns,
    riskLevel,
    summary: risks.length > 0 ? risks.join("; ") : "No obvious security concerns",
  };
}
