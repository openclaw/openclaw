/**
 * WSL environment diagnostics for `openclaw doctor`.
 *
 * Provides proactive health checks for users running OpenClaw under
 * Windows Subsystem for Linux (WSL/WSL2). Detects common
 * configuration issues and emits actionable fix suggestions.
 *
 * Checks performed:
 *   1. .wslconfig resource limits — memory / processors / swap
 *   2. WSL version and kernel — informational context for diagnostics
 *   3. systemd status — displayed in summary (detailed systemd
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
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contributions.js";
import { isWSL } from "../infra/wsl.js";
import { isWSL2Sync } from "../infra/wsl.js";
import { note } from "../terminal/note.js";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

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
  /** Host total memory in bytes (from os.totalmem()). */
  hostTotalMemoryBytes: number;
};

/** Parsed resource settings from .wslconfig [wsl2] section. */
export type WSLConfigResources = {
  /** Memory cap as written in .wslconfig (e.g. "8GB"). */
  memory: string | null;
  /** Processor core count allocated to WSL. */
  processors: number | null;
  /** Swap size as written in .wslconfig (e.g. "4GB"). */
  swap: string | null;
};

// ─── INI Parser ─────────────────────────────────────────────────

/**
 * Minimal INI parser for wsl.conf / .wslconfig files.
 * Returns a map of section → key → value. Lines before any
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
      const value = line.slice(eqIndex + 1).trim();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      result[currentSection][key] = value;
    }
  }
  return result;
}

// ─── Data Collectors ────────────────────────────────────────────

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

/**
 * Resolve the Windows user profile directory path from within WSL.
 *
 * Strategy (in priority order):
 *   1. `wslvar USERPROFILE` — most reliable, queries Windows env directly
 *   2. `wslpath` conversion of USERPROFILE env var — if WSLENV passes it
 *   3. Heuristic fallback — /mnt/c/Users/<username>
 *
 * Returns a WSL-native path (e.g. /mnt/c/Users/james) or null.
 */
export async function resolveWindowsUserProfilePath(): Promise<string | null> {
  // Strategy 1: wslvar + wslpath (most reliable)
  try {
    const { stdout: winProfile } = await execFileAsync("wslvar", ["USERPROFILE"], {
      timeout: 3000,
    });
    const trimmedWinProfile = winProfile.trim();
    if (trimmedWinProfile) {
      const { stdout: wslPath } = await execFileAsync("wslpath", ["-u", trimmedWinProfile], {
        timeout: 3000,
      });
      const resolved = wslPath.trim();
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    // wslvar/wslpath not available — fall through
  }

  // Strategy 2: USERPROFILE env var with manual conversion
  const windowsUserProfile = process.env.USERPROFILE ?? null;
  if (windowsUserProfile) {
    const converted = windowsUserProfile
      .replace(/\\/g, "/")
      .replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`);
    try {
      await fs.access(converted);
      return converted;
    } catch {
      // Path not accessible — fall through
    }
  }

  // Strategy 3: heuristic fallback
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
      return { memory: null, processors: null, swap: null };
    }
    return {
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
      hostTotalMemoryBytes: os.totalmem(),
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
    hostTotalMemoryBytes: os.totalmem(),
  };
}

// ─── Diagnostic Report ──────────────────────────────────────────

/**
 * Parse a memory string (e.g. "8GB", "4096MB") into megabytes.
 * Returns null when the value cannot be parsed.
 */
export function parseMemoryToMB(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(gb|mb|g|m|tb|t)?$/);
  if (!match) {
    return null;
  }
  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num)) {
    return null;
  }
  const unit = match[2] ?? "mb";
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
    default:
      return null;
  }
}

/**
 * Build user-facing diagnostic notes from WSL diagnostics.
 * Returns an empty array when everything looks healthy.
 *
 * Note: systemd diagnostics are intentionally omitted here —
 * the gateway daemon flow already handles systemd-unavailable
 * messaging with WSL-specific hints. This check focuses on
 * resource limits and environment information that no other
 * Doctor contribution covers.
 */
export function buildWSLDiagnosticNotes(diag: WSLDiagnostics): string[] {
  if (!diag.isWSL) {
    return [];
  }

  const notes: string[] = [];

  // ── Resource limit checks ──
  if (diag.wslconfig) {
    const memoryMB = parseMemoryToMB(diag.wslconfig.memory);
    if (memoryMB !== null && memoryMB < 4096) {
      notes.push(
        `WSL memory limit is ${diag.wslconfig.memory} — this may be too low for OpenClaw.`,
      );
      notes.push("Recommended: at least 4GB. Edit %USERPROFILE%\\.wslconfig [wsl2] memory=8GB");
    }
    if (diag.wslconfig.processors !== null && diag.wslconfig.processors < 2) {
      notes.push(
        `WSL processor limit is ${diag.wslconfig.processors} — OpenClaw performs better with 2+ cores.`,
      );
      notes.push("Edit %USERPROFILE%\\.wslconfig [wsl2] processors=4");
    }
  } else {
    const hostMemGB = Math.round(diag.hostTotalMemoryBytes / (1024 * 1024 * 1024));
    if (hostMemGB > 0) {
      const wslDefaultMemGB = Math.floor(hostMemGB / 2);
      if (wslDefaultMemGB < 4) {
        notes.push(
          `No .wslconfig found. WSL defaults to ~${wslDefaultMemGB}GB memory (half of ${hostMemGB}GB host).`,
        );
        notes.push("Tip: create %USERPROFILE%\\.wslconfig to set explicit resource limits.");
      }
    }
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
  parts.push(diag.systemdAvailable ? "systemd ✓" : "systemd ✗");
  if (diag.wslconfig?.memory) {
    parts.push(`memory limit ${diag.wslconfig.memory}`);
  }
  if (diag.wslconfig?.processors) {
    parts.push(`${diag.wslconfig.processors} processors`);
  }
  return parts.join(" · ");
}

// ─── Doctor Contribution Entry Point ────────────────────────────

/**
 * Doctor health contribution: WSL environment diagnostics.
 *
 * Only runs on Linux + WSL. Silently skips on other platforms.
 * Emits an environment summary note and, when resource limit
 * issues are found, a diagnostics note with actionable suggestions.
 *
 * systemd diagnostics are intentionally left to the gateway daemon
 * flow to avoid duplicate messaging — this contribution focuses on
 * environment context and resource limits.
 */
export async function noteWSLEnvironment(_ctx: DoctorHealthFlowContext): Promise<void> {
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
