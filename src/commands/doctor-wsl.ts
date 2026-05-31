/**
 * WSL environment diagnostics for `openclaw doctor`.
 *
 * Provides proactive health checks for users running OpenClaw under
 * Windows Subsystem for Linux (WSL/WSL2). Detects common
 * configuration issues and emits actionable fix suggestions.
 *
 * Checks performed:
 *   1. .wslconfig resource limits: memory / processors / swap (WSL2 only)
 *   2. WSL version and kernel: informational context for diagnostics
 *   3. systemd status: displayed in summary (detailed systemd
 *      diagnostics are handled by the gateway daemon flow to
 *      avoid duplicate messaging)
 *
 * Registered as a Doctor health contribution. Activates only on
 * Linux + WSL; silently skips on all other platforms.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { isWSL, isWSL2Sync } from "../infra/wsl.js";

const execFileAsync = promisify(execFile);
const WINDOWS_CMD_CANDIDATES = ["cmd.exe", "/mnt/c/Windows/System32/cmd.exe"] as const;

// Types

/** Complete WSL environment diagnostics result. */
export type WSLDiagnostics = {
  /** Whether the current environment is WSL. */
  isWSL: boolean;
  /** Whether the environment is WSL2 (as opposed to WSL1). */
  isWSL2: boolean;
  /** Whether systemd user services are available. */
  systemdAvailable: boolean;
  /** Whether /etc/wsl.conf contains [boot] systemd=true. null if unreadable. */
  wslConfSystemdEnabled: boolean | null;
  /** Resource limits from the Windows-side .wslconfig file. */
  wslconfig: WSLConfigResources | null;
  /** WSL kernel version string. */
  kernelVersion: string | null;
  /**
   * Total memory visible to the WSL instance in bytes (from os.totalmem()).
   * Note: inside WSL this reflects the VM allocation (~50% of host RAM
   * by default), not the Windows host total.
   */
  wslVisibleMemoryBytes: number;
};

/** Parsed resource settings from .wslconfig [wsl2] section. */
export type WSLConfigResources = {
  /** Whether the file has a [wsl2] section. */
  hasWsl2Section?: boolean;
  /** Memory cap as written in .wslconfig (e.g. "8GB"). */
  memory: string | null;
  /** Processor core count allocated to WSL. */
  processors: number | null;
  /** Swap size as written in .wslconfig (e.g. "4GB"). */
  swap: string | null;
};

// INI parser

/**
 * Minimal INI parser for wsl.conf / .wslconfig files.
 * Returns a map of section -> key -> value. Lines before any
 * section header are filed under the empty string key "".
 */
export function parseINI(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex > 0) {
      const key = line.slice(0, eqIndex).trim().toLowerCase();
      const value = line
        .slice(eqIndex + 1)
        .replace(/\s+[;#].*$/, "")
        .trim();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      result[currentSection][key] = value;
    }
  }
  return result;
}

export function windowsPathToDefaultWslMountPath(windowsPath: string): string | null {
  const normalized = windowsPath.trim().replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.+)$/);
  if (!match) {
    return null;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function formatGiB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "");
}

// Data collectors

/**
 * Check whether /etc/wsl.conf has [boot] systemd=true.
 * Returns true/false, or null when the file cannot be read.
 */
export async function readWslConfSystemdEnabled(): Promise<boolean | null> {
  try {
    const content = await fs.readFile("/etc/wsl.conf", "utf8");
    const ini = parseINI(content);
    const bootSection = ini["boot"];
    if (!bootSection) {
      return false;
    }
    const systemdValue = bootSection["systemd"];
    if (systemdValue === undefined) {
      return false;
    }
    return systemdValue.toLowerCase() === "true";
  } catch {
    return null;
  }
}

async function resolveAccessibleWindowsProfilePath(windowsPath: string): Promise<string | null> {
  const trimmed = windowsPath.trim();
  if (!trimmed || trimmed === "%USERPROFILE%") {
    return null;
  }

  const candidates: string[] = [];
  try {
    const { stdout } = await execFileAsync("wslpath", ["-u", trimmed], {
      encoding: "utf8",
      timeout: 3000,
    });
    const resolved = stdout.trim();
    if (resolved) {
      candidates.push(resolved);
    }
  } catch {
    // wslpath is optional; the default /mnt/<drive> conversion covers common installs.
  }

  const defaultMountPath = windowsPathToDefaultWslMountPath(trimmed);
  if (defaultMountPath) {
    candidates.push(defaultMountPath);
  }

  for (const candidate of new Set(candidates)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep trying lower-confidence candidates.
    }
  }
  return null;
}

async function readWindowsUserProfileFromInterop(): Promise<string | null> {
  for (const cmdPath of WINDOWS_CMD_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(cmdPath, ["/c", "echo %USERPROFILE%"], {
        encoding: "utf8",
        timeout: 3000,
      });
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== "%USERPROFILE%") {
        return trimmed;
      }
    } catch {
      // Try the next Windows command path.
    }
  }
  return null;
}

/**
 * Resolve the Windows user profile directory path from within WSL.
 *
 * Strategy (in priority order):
 *   1. `wslvar USERPROFILE`: direct Windows env query when wslu is installed
 *   2. `cmd.exe /c echo %USERPROFILE%`: built-in Windows interop query
 *   3. `USERPROFILE` env var: if WSLENV passes it through
 *   4. Heuristic fallback: /mnt/c/Users/<linux-username>
 *
 * Returns a WSL-native path (e.g. /mnt/c/Users/james) or null.
 */
export async function resolveWindowsUserProfilePath(): Promise<string | null> {
  // Strategy 1: wslvar + wslpath.
  try {
    const { stdout: winProfile } = await execFileAsync("wslvar", ["USERPROFILE"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const resolved = await resolveAccessibleWindowsProfilePath(winProfile);
    if (resolved) {
      return resolved;
    }
  } catch {
    // wslvar/wslpath not available; fall through.
  }

  // Strategy 2: built-in Windows interop. This catches normal WSL installs
  // where the Linux username differs from the Windows profile name.
  const interopProfile = await readWindowsUserProfileFromInterop();
  if (interopProfile) {
    const resolved = await resolveAccessibleWindowsProfilePath(interopProfile);
    if (resolved) {
      return resolved;
    }
  }

  // Strategy 3: USERPROFILE env var with conversion.
  const windowsUserProfile = process.env.USERPROFILE ?? null;
  if (windowsUserProfile) {
    const resolved = await resolveAccessibleWindowsProfilePath(windowsUserProfile);
    if (resolved) {
      return resolved;
    }
  }

  // Strategy 4: heuristic fallback.
  const homeUser = os.userInfo().username;
  const fallback = `/mnt/c/Users/${homeUser}`;
  try {
    await fs.access(fallback);
    return fallback;
  } catch {
    return null;
  }
}

/**
 * Read the Windows-side .wslconfig file from within WSL.
 * Uses resolveWindowsUserProfilePath() for reliable path resolution.
 *
 * Returns null when:
 *   - The Windows profile path cannot be resolved
 *   - The .wslconfig file does not exist or is unreadable
 *   - The file exists but has no [wsl2] section (reported as present
 *     but missing WSL2 resource settings)
 */
export async function readWSLConfigResources(): Promise<WSLConfigResources | null> {
  const profilePath = await resolveWindowsUserProfilePath();
  if (!profilePath) {
    return null;
  }

  try {
    const content = await fs.readFile(`${profilePath}/.wslconfig`, "utf8");
    const ini = parseINI(content);
    const wsl2Section = ini["wsl2"];
    if (!wsl2Section) {
      return {
        hasWsl2Section: false,
        memory: null,
        processors: null,
        swap: null,
      };
    }
    return {
      hasWsl2Section: true,
      memory: wsl2Section["memory"] ?? null,
      processors: wsl2Section["processors"]
        ? Number.parseInt(wsl2Section["processors"], 10) || null
        : null,
      swap: wsl2Section["swap"] ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read the WSL kernel version from /proc/version.
 */
export async function readWSLKernelVersion(): Promise<string | null> {
  try {
    const version = await fs.readFile("/proc/version", "utf8");
    const match = version.match(/(\d+\.\d+\.\d+[\w.-]*microsoft[\w.-]*)/i);
    return match ? match[1] : version.trim().slice(0, 120);
  } catch {
    return null;
  }
}

/**
 * Collect all WSL environment diagnostics.
 * Returns a non-WSL stub when not running under WSL.
 */
export async function collectWSLDiagnostics(): Promise<WSLDiagnostics> {
  const wsl = await isWSL();
  if (!wsl) {
    return {
      isWSL: false,
      isWSL2: false,
      systemdAvailable: false,
      wslConfSystemdEnabled: null,
      wslconfig: null,
      kernelVersion: null,
      wslVisibleMemoryBytes: os.totalmem(),
    };
  }

  const [systemdAvailable, wslConfSystemdEnabled, wslconfig, kernelVersion] = await Promise.all([
    isSystemdUserServiceAvailable().catch(() => false),
    readWslConfSystemdEnabled(),
    readWSLConfigResources(),
    readWSLKernelVersion(),
  ]);

  return {
    isWSL: true,
    isWSL2: isWSL2Sync(),
    systemdAvailable,
    wslConfSystemdEnabled,
    wslconfig,
    kernelVersion,
    wslVisibleMemoryBytes: os.totalmem(),
  };
}

// Diagnostic report

/**
 * Parse a memory string (e.g. "8GB", "4096MB") into megabytes.
 * Returns null when the value cannot be parsed.
 */
export function parseMemoryToMB(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(gb|mb|g|m|tb|t|b)?$/);
  if (!match) {
    return null;
  }
  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num)) {
    return null;
  }
  // .wslconfig treats bare numbers (no unit suffix) as bytes.
  // See: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
  const unit = match[2] ?? "b";
  switch (unit) {
    case "tb":
    case "t":
      return num * 1024 * 1024;
    case "gb":
    case "g":
      return num * 1024;
    case "mb":
    case "m":
      return num;
    case "b":
      return num / (1024 * 1024);
    default:
      return null;
  }
}

/**
 * Build user-facing diagnostic notes from WSL diagnostics.
 * Returns an empty array when everything looks healthy.
 *
 * Note: systemd diagnostics are intentionally omitted here:
 * the gateway daemon flow already handles systemd-unavailable
 * messaging with WSL-specific hints. This check focuses on
 * resource limits and environment information that no other
 * Doctor contribution covers.
 *
 * Resource limit checks (.wslconfig) are gated behind isWSL2
 * because .wslconfig only controls resource allocation in WSL2.
 * WSL1 uses different mechanisms and the advice would be misleading.
 *
 * Memory note: inside WSL, os.totalmem() returns the memory visible
 * to the WSL VM (roughly 50% of Windows host RAM by default when
 * no .wslconfig is present), not the Windows host total. We compare
 * this value directly against the 4GB threshold without halving.
 */
export function buildWSLDiagnosticNotes(diag: WSLDiagnostics): string[] {
  if (!diag.isWSL) {
    return [];
  }

  const notes: string[] = [];

  // .wslconfig resource checks apply to WSL2 only; WSL1 does not
  // use .wslconfig for resource allocation.
  if (!diag.isWSL2) {
    return notes;
  }

  // Resource limit checks (WSL2 only).
  // 4GB threshold compared in bytes, before rounding, so values like
  // 3.5GB are not rounded up to 4 and silently pass the check.
  const fourGiB = 4 * 1024 * 1024 * 1024;
  const visibleBytes = diag.wslVisibleMemoryBytes;
  const visibleGB = formatGiB(visibleBytes);
  const memoryMB = diag.wslconfig ? parseMemoryToMB(diag.wslconfig.memory) : null;

  if (diag.wslconfig && memoryMB !== null) {
    if (memoryMB < 4096) {
      notes.push(
        `WSL memory limit is ${diag.wslconfig.memory} - this may be too low for OpenClaw.`,
      );
      notes.push("Recommended: at least 4GB. Edit %USERPROFILE%\\.wslconfig [wsl2] memory=8GB");
    } else if (visibleBytes > 0 && visibleBytes < fourGiB) {
      notes.push(
        `WSL currently exposes ~${visibleGB}GB memory even though .wslconfig sets ${diag.wslconfig.memory}.`,
      );
      notes.push(
        "Run wsl --shutdown from PowerShell, then restart OpenClaw so WSL applies the limit.",
      );
    }
  } else if (visibleBytes > 0 && visibleBytes < fourGiB) {
    // Either no .wslconfig, or a .wslconfig with no explicit memory key:
    // fall back to the VM-visible memory (os.totalmem reflects the VM
    // allocation directly inside WSL2, so compare without halving).
    if (diag.wslconfig) {
      if (diag.wslconfig.hasWsl2Section === false) {
        notes.push(
          `WSL .wslconfig has no [wsl2] section; WSL is currently limited to ~${visibleGB}GB.`,
        );
        notes.push("Add [wsl2] memory=8GB to %USERPROFILE%\\.wslconfig, then run wsl --shutdown.");
      } else {
        notes.push(
          `WSL .wslconfig has no memory limit set; WSL is currently limited to ~${visibleGB}GB.`,
        );
        notes.push("Recommended: at least 4GB. Edit %USERPROFILE%\\.wslconfig [wsl2] memory=8GB");
      }
    } else {
      notes.push(`No .wslconfig found. WSL is currently limited to ~${visibleGB}GB memory.`);
      notes.push("Tip: create %USERPROFILE%\\.wslconfig to set explicit resource limits.");
    }
  }

  if (diag.wslconfig && diag.wslconfig.processors !== null && diag.wslconfig.processors < 2) {
    notes.push(
      `WSL processor limit is ${diag.wslconfig.processors} - OpenClaw performs better with 2+ cores.`,
    );
    notes.push("Edit %USERPROFILE%\\.wslconfig [wsl2] processors=4");
  }

  return notes;
}

/**
 * Build a one-line WSL environment summary for Doctor output.
 * Returns null when not running under WSL.
 */
export function buildWSLInfoSummary(diag: WSLDiagnostics): string | null {
  if (!diag.isWSL) {
    return null;
  }
  const parts: string[] = [];
  parts.push(diag.isWSL2 ? "WSL2" : "WSL1");
  if (diag.kernelVersion) {
    parts.push(`kernel ${diag.kernelVersion}`);
  }
  parts.push(diag.systemdAvailable ? "systemd OK" : "systemd unavailable");
  if (diag.isWSL2 && diag.wslconfig?.memory) {
    parts.push(`memory limit ${diag.wslconfig.memory}`);
  }
  if (diag.isWSL2 && diag.wslconfig?.processors) {
    parts.push(`${diag.wslconfig.processors} processors`);
  }
  return parts.join(" | ");
}

// Doctor contribution entry point

/**
 * Doctor health contribution: WSL environment diagnostics.
 *
 * Only runs on Linux + WSL. Silently skips on other platforms.
 * Emits an environment summary note and, when resource limit
 * issues are found, a diagnostics note with actionable suggestions.
 *
 * systemd diagnostics are intentionally left to the gateway daemon
 * flow to avoid duplicate messaging; this contribution focuses on
 * environment context and resource limits.
 */
export async function noteWSLEnvironment(): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }

  const diag = await collectWSLDiagnostics();
  if (!diag.isWSL) {
    return;
  }

  // Always show the WSL environment summary
  const summary = buildWSLInfoSummary(diag);
  if (summary) {
    note(summary, "WSL environment");
  }

  // Show diagnostic warnings when resource issues are detected
  const diagnosticNotes = buildWSLDiagnosticNotes(diag);
  if (diagnosticNotes.length > 0) {
    note(diagnosticNotes.join("\n"), "WSL diagnostics");
  }
}
