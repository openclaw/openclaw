/**
 * Semantic safety analysis for exec commands.
 *
 * Provides fine-grained safety labels (destructive, network-access, git-write, etc.)
 * that go beyond blacklists by understanding command semantics.
 *
 * This complements the existing allowlist + safe-bin + approval system.
 */

import type { ExecCommandSegment } from "./exec-approvals-analysis.js";

export type CommandSafetyLevel = "safe" | "elevated" | "dangerous";

export type CommandSafetyAnalysis = {
  level: CommandSafetyLevel;
  isDestructive: boolean;
  isNetworkAccess: boolean;
  isGitWriteOperation: boolean;
  isPrivilegeEscalation: boolean;
  isDataExfiltration: boolean;
  isPersistence: boolean;
  reasons: string[];
};

/**
 * Known dangerous command signatures (static analysis).
 * These patterns represent operations that are almost always dangerous
 * regardless of context.
 */
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Recursive force delete
  { pattern: /^rm\s+-rf\s+\/(?:\s|$)/, reason: "recursive delete from root" },
  { pattern: /^rm\s+-rf\s+"\/(?:\s|"')/, reason: "recursive delete from root (quoted)" },
  { pattern: /^rm\s+-rf\s+'\/(?:\s|$)/, reason: "recursive delete from root (single-quoted)" },
  // Disk wipe
  { pattern: /^dd\s+.*of=\/(?:\s|$)/, reason: "dd writing to root device" },
  { pattern: /^mkfs\s+/, reason: "filesystem format" },
  { pattern: /^sfdisk\s+/, reason: "partition table manipulation" },
  { pattern: /^fdisk\s+/, reason: "partition editing" },
  // Fork bomb
  { pattern: /^:\(\)\s*\{\s*:\|\:\s*&\s*\}\s*;/, reason: "fork bomb" },
  // Overwrite bootloader
  { pattern: /^dd\s+.*of=.*boot/, reason: "writing to boot sector" },
  { pattern: /^dd\s+.*of=.*mbr/, reason: "writing to MBR" },
];

const PRIVILEGE_ESCALATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^sudo\s+su\s/, reason: "sudo su (privilege escalation)" },
  { pattern: /^chmod\s+777\s+/, reason: "chmod 777 (world writable)" },
  { pattern: /^chmod\s+[0-7][0-7][0-7]\s+[^\s]*\/$/, reason: "chmod making something fully accessible" },
  { pattern: /^chown\s+-R\s+[^\s]*:[^\s]*\s+\/(?:\s|$)/, reason: "chown -R to root recursively" },
  { pattern: /^passwd\s+root/, reason: "changing root password" },
];

const NETWORK_ACCESS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^curl\s+.+\s+-d\s+/, reason: "curl with POST data" },
  { pattern: /^wget\s+.+\s+-O\s+/, reason: "wget writing output file" },
  { pattern: /^nc\s+(-e|--exec)\s+/, reason: "netcat remote execution" },
  { pattern: /^ncat\s+(-e|--exec)\s+/, reason: "ncat remote execution" },
  { pattern: /^ssh\s+.*(-o\s+StrictHostKeyChecking=no\s+)?(-i\s+[^\s]+\s+)?[^\s@]+@[^\s]+(?:\s+['"]\/bin\/sh['"]|\s+['"]bash['"])?/, reason: "ssh remote shell" },
  { pattern: /^python3?\s+-c\s+.+import\s+os;?\s*os\.system/, reason: "python os.system call" },
  { pattern: /^python3?\s+-c\s+.+subprocess/, reason: "python subprocess call" },
  { pattern: /^perl\s+-e\s+/, reason: "perl -e code execution" },
  { pattern: /^ruby\s+-e\s+/, reason: "ruby -e code execution" },
  { pattern: /^php\s+-r\s+/, reason: "php -r code execution" },
  { pattern: /^curl\s+[^\s]+\s+\|/, reason: "curl piped to shell (remote code)" },
  { pattern: /^wget\s+[^\s]+\s+\|/, reason: "wget piped to shell (remote code)" },
];

const GIT_WRITE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^git\s+push\s+.*--force/, reason: "git push --force" },
  { pattern: /^git\s+push\s+.*--force-with-lease/, reason: "git push --force-with-lease" },
  { pattern: /^git\s+rebase\s+-i/, reason: "git interactive rebase" },
  { pattern: /^git\s+filter-branch/, reason: "git filter-branch (history rewrite)" },
  { pattern: /^git\s+push\s+.*--delete/, reason: "git push --delete (branch deletion)" },
  { pattern: /^git\s+push\s+origin\s+:/, reason: "git push origin : (delete ref)" },
];

const DATA_EXFILTRATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^curl\s+.+\s+(-d|--data|--data-binary)\s+['"]/, reason: "curl sending data" },
  { pattern: /^nc\s+.+\s+-p\s+[0-9]+\s+[<|]/, reason: "netcat receiving/redirecting" },
  { pattern: /^tar\s+.+\s+--exclude='\*'\s+-czvf\s+/, reason: "tar creating archive (potential exfil)" },
];

/**
 * Commands that are inherently safe (read-only, non-destructive).
 * These can be auto-allowed without argPattern restrictions.
 */
const SAFE_COMMANDS = new Set([
  "ls", "pwd", "whoami", "id", "date", "uptime", "hostname",
  "ps", "top", "htop", "free", "df", "du", "mount", "uname",
  "git", "git status", "git log", "git show", "git diff",
  "git branch", "git tag", "git stash list", "git reflog",
  "rg", "grep", "find", "fd", "cat", "head", "tail", "less",
  "wc", "sort", "uniq", "cut", "tr", "jq", "yaml",
  "curl --version", "wget --version", "git --version",
  "node --version", "python3 --version", "ruby --version",
]);

/**
 * Analyze a single command segment for semantic safety.
 */
export function analyzeSegmentSafety(segment: ExecCommandSegment): CommandSafetyAnalysis {
  const reasons: string[] = [];
  const argv = segment.argv;
  const commandLine = argv.join(" ");

  let isDestructive = false;
  let isNetworkAccess = false;
  let isGitWriteOperation = false;
  let isPrivilegeEscalation = false;
  let isDataExfiltration = false;

  // Check destructive patterns
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(commandLine)) {
      isDestructive = true;
      reasons.push(reason);
    }
  }

  // Check privilege escalation patterns
  for (const { pattern, reason } of PRIVILEGE_ESCALATION_PATTERNS) {
    if (pattern.test(commandLine)) {
      isPrivilegeEscalation = true;
      reasons.push(reason);
    }
  }

  // Check network access patterns
  for (const { pattern, reason } of NETWORK_ACCESS_PATTERNS) {
    if (pattern.test(commandLine)) {
      isNetworkAccess = true;
      reasons.push(reason);
    }
  }

  // Check git write patterns
  for (const { pattern, reason } of GIT_WRITE_PATTERNS) {
    if (pattern.test(commandLine)) {
      isGitWriteOperation = true;
      reasons.push(reason);
    }
  }

  // Check data exfiltration patterns
  for (const { pattern, reason } of DATA_EXFILTRATION_PATTERNS) {
    if (pattern.test(commandLine)) {
      isDataExfiltration = true;
      reasons.push(reason);
    }
  }

  // Determine overall safety level
  let level: CommandSafetyLevel;
  if (isDestructive || isPrivilegeEscalation) {
    level = "dangerous";
  } else if (isNetworkAccess || isGitWriteOperation || isDataExfiltration) {
    level = "elevated";
  } else if (SAFE_COMMANDS.has(commandLine) || SAFE_COMMANDS.has(argv[0])) {
    level = "safe";
  } else {
    level = "safe";
  }

  return {
    level,
    isDestructive,
    isNetworkAccess,
    isGitWriteOperation,
    isPrivilegeEscalation,
    isDataExfiltration,
    isPersistence: false,
    reasons,
  };
}

/**
 * Analyze a full argv array for semantic safety.
 */
export function analyzeArgvSafety(argv: string[]): CommandSafetyAnalysis {
  const reasons: string[] = [];
  const commandLine = argv.join(" ");

  let isDestructive = false;
  let isNetworkAccess = false;
  let isGitWriteOperation = false;
  let isPrivilegeEscalation = false;
  let isDataExfiltration = false;

  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(commandLine)) {
      isDestructive = true;
      reasons.push(reason);
    }
  }
  for (const { pattern, reason } of PRIVILEGE_ESCALATION_PATTERNS) {
    if (pattern.test(commandLine)) {
      isPrivilegeEscalation = true;
      reasons.push(reason);
    }
  }
  for (const { pattern, reason } of NETWORK_ACCESS_PATTERNS) {
    if (pattern.test(commandLine)) {
      isNetworkAccess = true;
      reasons.push(reason);
    }
  }
  for (const { pattern, reason } of GIT_WRITE_PATTERNS) {
    if (pattern.test(commandLine)) {
      isGitWriteOperation = true;
      reasons.push(reason);
    }
  }
  for (const { pattern, reason } of DATA_EXFILTRATION_PATTERNS) {
    if (pattern.test(commandLine)) {
      isDataExfiltration = true;
      reasons.push(reason);
    }
  }

  let level: CommandSafetyLevel;
  if (isDestructive || isPrivilegeEscalation) {
    level = "dangerous";
  } else if (isNetworkAccess || isGitWriteOperation || isDataExfiltration) {
    level = "elevated";
  } else {
    level = "safe";
  }

  return {
    level,
    isDestructive,
    isNetworkAccess,
    isGitWriteOperation,
    isPrivilegeEscalation,
    isDataExfiltration,
    isPersistence: false,
    reasons,
  };
}

/**
 * Get a human-readable label for the safety level.
 */
export function safetyLevelLabel(level: CommandSafetyLevel): string {
  switch (level) {
    case "dangerous":
      return "DANGEROUS";
    case "elevated":
      return "ELEVATED";
    case "safe":
      return "safe";
  }
}

/**
 * Check if a command should require explicit confirmation based on safety level.
 * Dangerous commands should always require confirmation.
 * Elevated commands depend on the ask policy.
 */
export function requiresSafetyConfirmation(
  level: CommandSafetyLevel,
  askPolicy: "off" | "on-miss" | "always",
): boolean {
  if (askPolicy === "always") return true;
  if (askPolicy === "off") return false;
  // "on-miss" — confirm for elevated/dangerous when not in allowlist
  return level !== "safe";
}
