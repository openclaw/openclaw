/**
 * Security Level Classification for Exec Commands
 *
 * Classifies commands by risk level (safe → critical) and enforces
 * maximum allowed level set by the user in the UI.
 *
 * Levels (lowest to highest risk):
 * - safe: Read-only information gathering
 * - low: Project file modifications
 * - medium: Configuration or dependency changes
 * - high: System-level changes
 * - critical: Potential data loss or security risk
 */

export type ExecSecurityLevel = "safe" | "low" | "medium" | "high" | "critical";

export const SECURITY_LEVEL_ORDER: ExecSecurityLevel[] = [
  "safe",
  "low",
  "medium",
  "high",
  "critical",
];

export const SECURITY_LEVEL_INFO: Record<
  ExecSecurityLevel,
  { emoji: string; label: string; desc: string }
> = {
  safe: { emoji: "🟢", label: "SAFE", desc: "Read-only information gathering" },
  low: { emoji: "🔵", label: "LOW", desc: "Project file modifications" },
  medium: { emoji: "🟡", label: "MEDIUM", desc: "Configuration or dependency changes" },
  high: { emoji: "🟠", label: "HIGH", desc: "System-level changes" },
  critical: { emoji: "🔴", label: "CRITICAL", desc: "Potential data loss or security risk" },
};

/**
 * Command patterns for each security level.
 * Checked in order from critical → safe (most dangerous first).
 */
const COMMAND_PATTERNS: Record<ExecSecurityLevel, string[]> = {
  critical: [
    "sudo",
    "rm -rf",
    "rm -fr",
    "mkfs",
    "dd if=",
    "dd of=",
    "shred",
    "chmod 777 -R",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "kill -9 -1",
    "drop table",
    "drop database",
    "truncate",
    "curl | sh",
    "curl | bash",
    "wget | sh",
    "wget | bash",
    "> /dev/sd",
    ":(){ :|:", // fork bomb
    "mv /* ",
    "rm /*",
  ],
  high: [
    "systemctl start",
    "systemctl stop",
    "systemctl restart",
    "systemctl enable",
    "systemctl disable",
    "apt install",
    "apt remove",
    "apt purge",
    "apt upgrade",
    "apt-get install",
    "apt-get remove",
    "brew install",
    "brew uninstall",
    "dnf install",
    "pacman -S",
    "npm install -g",
    "pip install --user",
    "useradd",
    "userdel",
    "usermod",
    "groupadd",
    "groupdel",
    "chown -R",
    "chmod -R",
    "ufw",
    "iptables",
    "crontab -e",
    "crontab -r",
    "mount",
    "umount",
    "fdisk",
    "parted",
    "service ",
    "launchctl",
  ],
  medium: [
    "npm install",
    "npm update",
    "npm uninstall",
    "pnpm install",
    "pnpm add",
    "pnpm remove",
    "yarn install",
    "yarn add",
    "yarn remove",
    "pip install",
    "pip3 install",
    "pip uninstall",
    "composer install",
    "composer require",
    "bundle install",
    "gem install",
    "go get",
    "go install",
    "cargo add",
    "cargo install",
    "git push",
    "git pull",
    "git merge",
    "git rebase",
    "git reset",
    "docker run",
    "docker exec",
    "docker build",
    "docker stop",
    "docker rm",
    "kubectl apply",
    "kubectl delete",
    "chmod",
    "chown",
    "ln -s",
    "make install",
    "ssh ",
    "scp ",
    "rsync",
    "npm run build",
    "npm run deploy",
  ],
  low: [
    "touch",
    "mkdir",
    "cp ",
    "mv ",
    "rm ",
    "rmdir",
    "git add",
    "git commit",
    "git stash",
    "git checkout",
    "git branch",
    "git switch",
    "echo >",
    "cat >",
    "tee ",
    "sed -i",
    "make",
    "npm run",
    "pnpm run",
    "yarn run",
    "node ",
    "python ",
    "python3 ",
    "tar ",
    "unzip ",
    "zip ",
    "gzip ",
    "gunzip ",
  ],
  safe: [
    "ls",
    "ll",
    "la",
    "dir",
    "cat ",
    "head ",
    "tail ",
    "less ",
    "more ",
    "grep ",
    "rg ",
    "find ",
    "which ",
    "whereis ",
    "type ",
    "pwd",
    "cd ",
    "whoami",
    "id",
    "groups",
    "date",
    "cal",
    "uptime",
    "uname",
    "hostname",
    "echo ",
    "printf ",
    "env",
    "printenv",
    "man ",
    "help",
    "--help",
    "--version",
    "-v",
    "-V",
    "file ",
    "stat ",
    "wc ",
    "du ",
    "df ",
    "free",
    "top",
    "htop",
    "ps ",
    "netstat",
    "ss ",
    "ip addr",
    "ping ",
    "dig ",
    "nslookup ",
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch -l",
    "git remote",
    "npm list",
    "npm view",
    "npm outdated",
    "pip list",
    "pip show",
    "docker ps",
    "docker images",
    "docker logs",
    "tree",
    "jq ",
    "sort ",
    "diff ",
    "curl ", // read-only by default, dangerous patterns caught above
    "wget ",
    "clawhub ",
    "openclaw ",
  ],
};

/**
 * Classify a command by its security level.
 * Checks patterns from most dangerous (critical) to least (safe).
 */
export function classifyCommand(command: string): ExecSecurityLevel {
  const lower = command.trim().toLowerCase();

  // Check each level from most dangerous to least
  for (const level of ["critical", "high", "medium", "low", "safe"] as ExecSecurityLevel[]) {
    for (const pattern of COMMAND_PATTERNS[level]) {
      if (lower.includes(pattern.toLowerCase())) {
        return level;
      }
    }
  }

  // Default to medium for unknown commands (fail-safe)
  return "medium";
}

/**
 * Get the numeric index of a security level (lower = safer).
 */
export function getSecurityLevelIndex(level: ExecSecurityLevel): number {
  return SECURITY_LEVEL_ORDER.indexOf(level);
}

/**
 * Check if a command's security level exceeds the maximum allowed level.
 * Returns true if the command should be BLOCKED.
 */
export function exceedsSecurityLevel(
  commandLevel: ExecSecurityLevel,
  maxAllowedLevel: ExecSecurityLevel,
): boolean {
  return getSecurityLevelIndex(commandLevel) > getSecurityLevelIndex(maxAllowedLevel);
}

/**
 * Validate a command against a maximum security level.
 * Returns an error message if blocked, or null if allowed.
 */
export function validateCommandSecurityLevel(
  command: string,
  maxAllowedLevel: ExecSecurityLevel,
): { allowed: true } | { allowed: false; commandLevel: ExecSecurityLevel; error: string } {
  const commandLevel = classifyCommand(command);

  if (exceedsSecurityLevel(commandLevel, maxAllowedLevel)) {
    const cmdInfo = SECURITY_LEVEL_INFO[commandLevel];
    const maxInfo = SECURITY_LEVEL_INFO[maxAllowedLevel];
    return {
      allowed: false,
      commandLevel,
      error:
        `Security level violation: Command classified as ${cmdInfo.emoji} ${cmdInfo.label} ` +
        `but maximum allowed level is ${maxInfo.emoji} ${maxInfo.label}.\n` +
        `Increase security level in the UI to execute this command, or ask for approval.`,
    };
  }

  return { allowed: true };
}

/**
 * Normalize a security level string, returning null if invalid.
 */
export function normalizeSecurityLevel(value?: string | null): ExecSecurityLevel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (SECURITY_LEVEL_ORDER.includes(normalized as ExecSecurityLevel)) {
    return normalized as ExecSecurityLevel;
  }
  return null;
}
