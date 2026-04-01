/**
 * Sensitive Path Protection - Protects dangerous files and directories from modification.
 *
 * Inspired by Claude Code's filesystem.ts implementation.
 * These paths require explicit user approval even in "full" security mode.
 *
 * Key concept: "Bypass Immunity"
 * Some paths are so sensitive that they should ALWAYS require manual approval,
 * regardless of security mode settings. This prevents accidental exposure of
 * credentials, shell hijacking, and other high-impact attacks.
 *
 * @see https://github.com/anthropics/claude-code - Reference implementation
 */

import path from "node:path";
import os from "node:os";

/**
 * Dangerous files that should be protected from auto-editing.
 * These files can be used for code execution or data exfiltration.
 */
export const DANGEROUS_FILES = [
  // Git configuration - can execute code via hooks, aliases, or core.fsmonitor
  ".gitconfig",
  ".gitmodules",

  // Shell configuration - executed on shell startup
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".login",
  ".cshrc",
  ".tcshrc",
  ".kshrc",

  // Fish shell
  "config.fish",

  // PowerShell profiles
  "Microsoft.PowerShell_profile.ps1",
  "profile.ps1",

  // Tool configuration that can execute code
  ".ripgreprc",
  ".npmrc", // Can set scripts
  ".yarnrc",
  ".yarnrc.yml",

  // OpenClaw/Claude configuration
  ".mcp.json",
  ".claude.json",
  ".openclaw.json",

  // SSH configuration
  ".ssh/config",
  ".ssh/authorized_keys",
  ".ssh/known_hosts",

  // Cron jobs
  "crontab",
] as const;

/**
 * Dangerous directories that should be protected from auto-editing.
 * These directories contain sensitive configuration or executable files.
 */
export const DANGEROUS_DIRECTORIES = [
  // Version control - can execute code via hooks
  ".git",
  ".svn",
  ".hg",

  // IDE/Editor settings - can execute tasks/extensions
  ".vscode",
  ".idea",
  ".eclipse",
  ".sublime-project",
  ".sublime-workspace",

  // OpenClaw/Claude configuration
  ".claude",
  ".openclaw",

  // Package manager directories with potential scripts
  "node_modules/.bin",

  // System configuration
  ".config",
  ".local/bin",
] as const;

/**
 * Files in .git directory that are particularly dangerous.
 * These can be used for "bare repo" attacks where planting these files
 * makes git treat the current directory as a repository.
 */
export const GIT_BARE_REPO_FILES = ["HEAD", "objects", "refs", "hooks", "config"] as const;

export type SensitivePathCheckResult =
  | { sensitive: false }
  | {
      sensitive: true;
      reason: string;
      /** Whether an AI classifier can auto-approve this (false = always require human) */
      classifierApprovable: boolean;
      /** The matched pattern that triggered this check */
      matchedPattern: string;
    };

/**
 * Normalize path for case-insensitive comparison.
 * This prevents bypassing security checks using mixed-case paths
 * on case-insensitive filesystems (macOS/Windows).
 */
export function normalizeCaseForComparison(filePath: string): string {
  return filePath.toLowerCase();
}

/**
 * Check if a file path matches a dangerous file pattern.
 */
function matchesDangerousFile(filePath: string): string | null {
  const normalizedPath = normalizeCaseForComparison(filePath);
  const fileName = path.basename(normalizedPath);

  for (const dangerousFile of DANGEROUS_FILES) {
    const normalizedDangerous = normalizeCaseForComparison(dangerousFile);
    if (fileName === normalizedDangerous) {
      return dangerousFile;
    }
    // Also check if path ends with the dangerous file pattern (e.g., .ssh/config)
    if (dangerousFile.includes("/") && normalizedPath.endsWith(normalizeCaseForComparison(dangerousFile))) {
      return dangerousFile;
    }
  }

  return null;
}

/**
 * Check if a file path is within a dangerous directory.
 */
function matchesDangerousDirectory(filePath: string): string | null {
  const normalizedPath = normalizeCaseForComparison(filePath);
  const segments = normalizedPath.split(path.sep);

  for (const dangerousDir of DANGEROUS_DIRECTORIES) {
    const normalizedDir = normalizeCaseForComparison(dangerousDir);
    // Check if any segment matches the dangerous directory
    if (segments.includes(normalizedDir)) {
      return dangerousDir;
    }
    // Check for multi-segment patterns (e.g., node_modules/.bin)
    if (dangerousDir.includes("/")) {
      const dirParts = normalizedDir.split("/");
      for (let i = 0; i <= segments.length - dirParts.length; i++) {
        const match = dirParts.every((part, j) => segments[i + j] === part);
        if (match) {
          return dangerousDir;
        }
      }
    }
  }

  return null;
}

/**
 * Check if a path contains suspicious Windows path patterns.
 * These patterns can be used to bypass security checks.
 */
function hasSuspiciousWindowsPattern(filePath: string): { suspicious: true; reason: string } | { suspicious: false } {
  // NTFS Alternate Data Streams (e.g., file.txt::$DATA, file.txt:stream)
  // Only check on Windows-like paths (has drive letter or starts with \\)
  const isWindowsPath = /^[a-zA-Z]:/.test(filePath) || filePath.startsWith("\\\\");
  if (isWindowsPath) {
    const colonIndex = filePath.indexOf(":", 2);
    if (colonIndex !== -1) {
      return { suspicious: true, reason: "NTFS Alternate Data Stream detected" };
    }
  }

  // 8.3 short names (e.g., GIT~1, CLAUDE~1)
  if (/~\d/.test(filePath)) {
    return { suspicious: true, reason: "8.3 short name pattern detected" };
  }

  // Long path prefixes (e.g., \\?\C:\..., //?/C:/...)
  if (
    filePath.startsWith("\\\\?\\") ||
    filePath.startsWith("\\\\.\\") ||
    filePath.startsWith("//?/") ||
    filePath.startsWith("//./")
  ) {
    return { suspicious: true, reason: "Long path prefix detected" };
  }

  // Trailing dots and spaces (Windows strips these during path resolution)
  if (/[.\s]+$/.test(filePath)) {
    return { suspicious: true, reason: "Trailing dots or spaces detected" };
  }

  // DOS device names
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(filePath)) {
    return { suspicious: true, reason: "DOS device name detected" };
  }

  // Three or more consecutive dots as path component
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(filePath)) {
    return { suspicious: true, reason: "Suspicious dot sequence detected" };
  }

  // UNC paths (can access network resources, leak credentials)
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    return { suspicious: true, reason: "UNC path detected" };
  }

  return { suspicious: false };
}

/**
 * Check if a path is sensitive and requires special handling.
 *
 * @param filePath - The file path to check
 * @param options - Optional configuration
 * @returns Check result indicating if path is sensitive and why
 */
export function checkSensitivePath(
  filePath: string,
  options?: {
    /** Check Windows-specific patterns even on non-Windows platforms */
    checkWindowsPatterns?: boolean;
    /** Additional custom patterns to check */
    additionalDangerousFiles?: string[];
    additionalDangerousDirectories?: string[];
  },
): SensitivePathCheckResult {
  // Check Windows-specific patterns first (these are never auto-approvable)
  const windowsCheck = hasSuspiciousWindowsPattern(filePath);
  if (windowsCheck.suspicious) {
    return {
      sensitive: true,
      reason: windowsCheck.reason,
      classifierApprovable: false, // Never auto-approve suspicious Windows patterns
      matchedPattern: filePath,
    };
  }

  // Check dangerous files
  const dangerousFile = matchesDangerousFile(filePath);
  if (dangerousFile) {
    return {
      sensitive: true,
      reason: `Modifying ${dangerousFile} could allow arbitrary code execution`,
      classifierApprovable: true, // AI classifier can approve with context
      matchedPattern: dangerousFile,
    };
  }

  // Check custom dangerous files
  if (options?.additionalDangerousFiles) {
    const normalizedPath = normalizeCaseForComparison(filePath);
    for (const customFile of options.additionalDangerousFiles) {
      if (normalizedPath.endsWith(normalizeCaseForComparison(customFile))) {
        return {
          sensitive: true,
          reason: `Custom sensitive file pattern: ${customFile}`,
          classifierApprovable: true,
          matchedPattern: customFile,
        };
      }
    }
  }

  // Check dangerous directories
  const dangerousDir = matchesDangerousDirectory(filePath);
  if (dangerousDir) {
    return {
      sensitive: true,
      reason: `Files in ${dangerousDir}/ directory can be used for code execution or configuration injection`,
      classifierApprovable: true, // AI classifier can approve with context
      matchedPattern: dangerousDir,
    };
  }

  // Check custom dangerous directories
  if (options?.additionalDangerousDirectories) {
    const normalizedPath = normalizeCaseForComparison(filePath);
    for (const customDir of options.additionalDangerousDirectories) {
      const normalizedDir = normalizeCaseForComparison(customDir);
      if (normalizedPath.includes(`${path.sep}${normalizedDir}${path.sep}`)) {
        return {
          sensitive: true,
          reason: `Custom sensitive directory pattern: ${customDir}`,
          classifierApprovable: true,
          matchedPattern: customDir,
        };
      }
    }
  }

  return { sensitive: false };
}

/**
 * Check if a path is a sensitive OpenClaw/Claude settings path.
 */
export function isSettingsPath(filePath: string): boolean {
  const normalizedPath = normalizeCaseForComparison(filePath);

  // Check for settings.json patterns
  const settingsPatterns = [
    `${path.sep}.openclaw${path.sep}settings.json`,
    `${path.sep}.openclaw${path.sep}settings.local.json`,
    `${path.sep}.claude${path.sep}settings.json`,
    `${path.sep}.claude${path.sep}settings.local.json`,
  ];

  for (const pattern of settingsPatterns) {
    if (normalizedPath.endsWith(normalizeCaseForComparison(pattern))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a path is within the user's home directory sensitive locations.
 */
export function isHomeSensitivePath(filePath: string): boolean {
  const homeDir = os.homedir();
  const normalizedPath = normalizeCaseForComparison(path.resolve(filePath));
  const normalizedHome = normalizeCaseForComparison(homeDir);

  if (!normalizedPath.startsWith(normalizedHome)) {
    return false;
  }

  const relativePath = normalizedPath.slice(normalizedHome.length);

  // Check for sensitive home subdirectories
  const sensitiveDirs = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config/gcloud"];

  for (const dir of sensitiveDirs) {
    const normalizedDir = normalizeCaseForComparison(dir);
    if (relativePath.startsWith(`${path.sep}${normalizedDir}${path.sep}`) || relativePath === `${path.sep}${normalizedDir}`) {
      return true;
    }
  }

  return false;
}

/**
 * Get all paths that should be protected in a directory.
 * Useful for sandbox configuration.
 */
export function getProtectedPathsInDirectory(directory: string): string[] {
  const protected_paths: string[] = [];

  // Add dangerous directories
  for (const dir of DANGEROUS_DIRECTORIES) {
    protected_paths.push(path.join(directory, dir));
  }

  // Add dangerous files
  for (const file of DANGEROUS_FILES) {
    protected_paths.push(path.join(directory, file));
  }

  // Add bare repo files (for git config attacks)
  for (const gitFile of GIT_BARE_REPO_FILES) {
    protected_paths.push(path.join(directory, gitFile));
  }

  return protected_paths;
}

/**
 * Validate that a write operation to a path should be allowed.
 * This is the main entry point for path-based write permission checks.
 *
 * @param filePath - Path to check
 * @param securityLevel - Current security level ("deny" | "allowlist" | "full")
 * @returns Validation result
 */
export function validateWritePath(
  filePath: string,
  securityLevel: "deny" | "allowlist" | "full",
): {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  classifierApprovable?: boolean;
} {
  // Always check sensitive paths, even in "full" mode
  const sensitiveCheck = checkSensitivePath(filePath);

  if (sensitiveCheck.sensitive) {
    // Sensitive paths always require approval, even in "full" mode
    // This is the "bypass immunity" concept from Claude Code
    return {
      allowed: false,
      requiresApproval: true,
      reason: sensitiveCheck.reason,
      classifierApprovable: sensitiveCheck.classifierApprovable,
    };
  }

  // Settings paths are always protected
  if (isSettingsPath(filePath)) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: "Modifying OpenClaw/Claude settings requires explicit approval",
      classifierApprovable: false, // Never auto-approve settings changes
    };
  }

  // Home sensitive paths are always protected
  if (isHomeSensitivePath(filePath)) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: "Modifying sensitive home directory files requires explicit approval",
      classifierApprovable: false,
    };
  }

  // For non-sensitive paths, respect security level
  switch (securityLevel) {
    case "deny":
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Write operations are denied in current security mode",
      };
    case "allowlist":
      return {
        allowed: false,
        requiresApproval: true,
        reason: "Path not in allowlist",
      };
    case "full":
      return {
        allowed: true,
        requiresApproval: false,
      };
    default:
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Unknown security level",
      };
  }
}
