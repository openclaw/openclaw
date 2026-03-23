/**
 * UFW / Linux firewall detection for the security audit.
 *
 * Handles the case where ufw lives in /usr/sbin or /sbin which may not be
 * on a non-root user's PATH (common on Debian/Ubuntu).
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import type { SecurityAuditFinding } from "./audit-extra.sync.js";

/** Standard sbin directories where ufw is commonly installed. */
const UFW_SBIN_PATHS = ["/usr/sbin/ufw", "/sbin/ufw", "/usr/local/sbin/ufw"] as const;

/** PATH augmentation so spawned ufw subprocess can find its own helpers. */
const SBIN_PATH_DIRS = "/usr/local/sbin:/usr/sbin:/sbin";

export type FirewallDetectionResult = {
  /** Resolved absolute path to the ufw binary, or null if not found. */
  ufwPath: string | null;
  /** Whether the binary was found via PATH (true) or sbin fallback (false). */
  foundViaPath: boolean;
  /** Whether UFW reports as active. null if we couldn't determine status. */
  active: boolean | null;
  /** Raw status output (first line) for diagnostics. */
  statusLine: string | null;
  /** Whether /etc/ufw/ufw.conf says ENABLED=yes. */
  confEnabled: boolean | null;
};

/**
 * Check whether a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the ufw binary: first via PATH, then by checking known sbin paths.
 */
export function locateUfw(env?: NodeJS.ProcessEnv): { path: string; viaPath: boolean } | null {
  const resolvedEnv = env ?? process.env;

  // Try PATH-based lookup first (via `which`).
  const whichResult = spawnSync("which", ["ufw"], {
    timeout: 3_000,
    env: resolvedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (whichResult.status === 0) {
    const resolved = whichResult.stdout.toString().trim();
    if (resolved) {
      return { path: resolved, viaPath: true };
    }
  }

  // Fallback: check standard sbin paths directly.
  for (const candidate of UFW_SBIN_PATHS) {
    if (isExecutable(candidate)) {
      return { path: candidate, viaPath: false };
    }
  }

  return null;
}

/**
 * Read /etc/ufw/ufw.conf and check for ENABLED=yes.
 */
export function readUfwConfEnabled(): boolean | null {
  try {
    const content = readFileSync("/etc/ufw/ufw.conf", "utf-8");
    // Match ENABLED=yes (case-insensitive value, ignoring comments).
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^ENABLED\s*=\s*(.+)$/i);
      if (match) {
        return match[1].trim().toLowerCase() === "yes";
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run `ufw status` using the given binary path, with sbin dirs added to PATH.
 */
export function queryUfwStatus(
  ufwPath: string,
  env?: NodeJS.ProcessEnv,
): {
  active: boolean | null;
  statusLine: string | null;
} {
  const resolvedEnv = env ?? process.env;
  const currentPath = resolvedEnv.PATH ?? "";
  const augmentedPath = currentPath ? `${SBIN_PATH_DIRS}:${currentPath}` : SBIN_PATH_DIRS;

  const result = spawnSync(ufwPath, ["status"], {
    timeout: 5_000,
    env: { ...resolvedEnv, PATH: augmentedPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    return { active: null, statusLine: null };
  }

  const stdout = result.stdout.toString();
  const firstLine = stdout.split(/\r?\n/)[0]?.trim() ?? null;

  // `ufw status` outputs "Status: active" or "Status: inactive"
  if (firstLine) {
    const isActive = /status:\s*active/i.test(firstLine);
    const isInactive = /status:\s*inactive/i.test(firstLine);
    if (isActive) {
      return { active: true, statusLine: firstLine };
    }
    if (isInactive) {
      return { active: false, statusLine: firstLine };
    }
  }

  return { active: null, statusLine: firstLine };
}

/**
 * Full UFW detection: locate binary, query status, check conf file.
 */
export function detectUfwFirewall(env?: NodeJS.ProcessEnv): FirewallDetectionResult {
  const location = locateUfw(env);

  if (!location) {
    // UFW binary not found anywhere — check conf as last resort.
    const confEnabled = readUfwConfEnabled();
    return {
      ufwPath: null,
      foundViaPath: false,
      active: null,
      statusLine: null,
      confEnabled,
    };
  }

  const status = queryUfwStatus(location.path, env);
  const confEnabled = readUfwConfEnabled();

  return {
    ufwPath: location.path,
    foundViaPath: location.viaPath,
    active: status.active,
    statusLine: status.statusLine,
    confEnabled,
  };
}

/**
 * Collect security audit findings related to UFW firewall status.
 * Only runs on Linux.
 */
export function collectFirewallFindings(params: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const platform = params.platform ?? process.platform;
  if (platform !== "linux") {
    return [];
  }

  const detection = detectUfwFirewall(params.env);
  const findings: SecurityAuditFinding[] = [];

  if (!detection.ufwPath) {
    // UFW not installed at all. Check conf-only fallback.
    if (detection.confEnabled === true) {
      findings.push({
        checkId: "firewall.ufw_conf_only",
        severity: "info",
        title: "UFW config says enabled but binary not found",
        detail:
          "/etc/ufw/ufw.conf has ENABLED=yes but the ufw binary was not found " +
          "in PATH or standard sbin directories (/usr/sbin, /sbin, /usr/local/sbin). " +
          "The firewall may be active via netfilter but cannot be queried.",
        remediation: "Install ufw or verify iptables/nftables rules directly.",
      });
    }
    // No UFW at all — not a finding (other firewall tools may be in use).
    return findings;
  }

  // UFW found but not via PATH — inform the user.
  if (!detection.foundViaPath) {
    findings.push({
      checkId: "firewall.ufw_not_on_path",
      severity: "info",
      title: "UFW found in sbin but not on PATH",
      detail:
        `UFW binary found at ${detection.ufwPath} but it is not on the current PATH. ` +
        "This is normal for non-root users on Debian/Ubuntu. " +
        "The security audit resolved it via sbin fallback paths.",
      remediation:
        "No action required. To suppress this note, add /usr/sbin to your PATH " +
        '(e.g. export PATH="/usr/sbin:$PATH" in your shell profile).',
    });
  }

  // Report UFW status.
  if (detection.active === true) {
    findings.push({
      checkId: "firewall.ufw_active",
      severity: "info",
      title: "UFW firewall is active",
      detail:
        `UFW is active (${detection.ufwPath}). ` +
        "Ensure the Gateway port is properly restricted in your UFW rules.",
    });
  } else if (detection.active === false) {
    findings.push({
      checkId: "firewall.ufw_inactive",
      severity: "warn",
      title: "UFW firewall is installed but inactive",
      detail:
        `UFW is installed at ${detection.ufwPath} but reports inactive. ` +
        "Without an active firewall, the Gateway port may be exposed.",
      remediation:
        "Enable UFW with appropriate rules: " +
        "`sudo ufw default deny incoming && sudo ufw allow ssh && sudo ufw enable`.",
    });
  } else {
    // Could not determine status (permission denied, etc.)
    const confHint =
      detection.confEnabled === true
        ? " /etc/ufw/ufw.conf indicates ENABLED=yes."
        : detection.confEnabled === false
          ? " /etc/ufw/ufw.conf indicates ENABLED=no."
          : "";
    findings.push({
      checkId: "firewall.ufw_status_unknown",
      severity: "info",
      title: "UFW installed but status could not be determined",
      detail:
        `UFW is installed at ${detection.ufwPath} but 'ufw status' did not return ` +
        `a recognizable result (may require root).${confHint}`,
      remediation: "Run `sudo ufw status` to check firewall status manually.",
    });
  }

  return findings;
}
