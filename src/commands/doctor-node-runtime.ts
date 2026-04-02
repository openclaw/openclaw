/**
 * Node.js runtime diagnostics for `openclaw doctor`.
 *
 * Emits a concise runtime summary note (version, path, version-manager
 * detection) and warns when the running Node version is approaching
 * end-of-life or is older than the recommended release line.
 *
 * Checks performed:
 *   1. Runtime summary — Node version, executable path, version-manager hint
 *   2. Version-manager detection — nvm / fnm / volta / asdf / n / nodenv / nodebrew / nvs
 *   3. EOL proximity warning — Node 22 enters maintenance Oct 2026, EOL Apr 2027
 *   4. Recommended version nudge — suggest Node 24 when running Node 22
 *
 * Registered as a Doctor health contribution. Always runs (Node is the
 * only supported runtime), but keeps output to a single informational
 * note plus optional warnings.
 *
 * This contribution reuses infrastructure from:
 *   - src/infra/runtime-guard.ts  (parseSemver, detectRuntime, MIN_NODE)
 *   - src/daemon/runtime-paths.ts (isVersionManagedNodePath)
 */

import process from "node:process";
import { isVersionManagedNodePath } from "../daemon/runtime-paths.js";
import {
  detectRuntime,
  parseSemver,
  runtimeSatisfies,
  type RuntimeDetails,
} from "../infra/runtime-guard.js";
import { note } from "../terminal/note.js";

// ─── Types ──────────────────────────────────────────────────────

/** Complete Node.js runtime diagnostics result. */
export type NodeRuntimeDiagnostics = {
  /** Node.js version string (e.g. "24.14.0"), or null if unknown. */
  version: string | null;
  /** Parsed major version number, or null if unparseable. */
  major: number | null;
  /** Absolute path to the Node.js executable. */
  execPath: string | null;
  /** Whether the executable lives under a known version manager directory. */
  versionManaged: boolean;
  /** Name of the detected version manager, or null. */
  versionManagerHint: string | null;
  /** Whether the current version satisfies the minimum requirement. */
  satisfiesMinimum: boolean;
  /** The full RuntimeDetails from runtime-guard. */
  runtimeDetails: RuntimeDetails;
};

// ─── Version Manager Detection ──────────────────────────────────

/**
 * Well-known version manager directory markers and their display names.
 * Order matches VERSION_MANAGER_MARKERS in runtime-paths.ts.
 */
const VERSION_MANAGER_NAMES: ReadonlyArray<{ marker: string; name: string }> = [
  { marker: "/.nvm/", name: "nvm" },
  { marker: "/.fnm/", name: "fnm" },
  { marker: "/.volta/", name: "volta" },
  { marker: "/.asdf/", name: "asdf" },
  { marker: "/.n/", name: "n" },
  { marker: "/.nodenv/", name: "nodenv" },
  { marker: "/.nodebrew/", name: "nodebrew" },
  { marker: "/nvs/", name: "nvs" },
];

/**
 * Detect which version manager (if any) manages the given Node path.
 * Returns the human-readable name or null.
 */
export function detectVersionManagerName(execPath: string | null): string | null {
  if (!execPath) {
    return null;
  }
  const normalized = execPath.replace(/\\/g, "/");
  for (const { marker, name } of VERSION_MANAGER_NAMES) {
    if (normalized.includes(marker)) {
      return name;
    }
  }
  return null;
}

// ─── Data Collector ─────────────────────────────────────────────

/**
 * Collect all Node.js runtime diagnostics.
 *
 * Accepts optional deps for testing. Production callers use
 * the defaults (process.execPath, detectRuntime()).
 */
export function collectNodeRuntimeDiagnostics(deps?: {
  runtimeDetails?: RuntimeDetails;
}): NodeRuntimeDiagnostics {
  const details = deps?.runtimeDetails ?? detectRuntime();
  const parsed = parseSemver(details.version);
  const execPath = details.execPath ?? process.execPath ?? null;

  return {
    version: details.version,
    major: parsed?.major ?? null,
    execPath,
    versionManaged: execPath ? isVersionManagedNodePath(execPath) : false,
    versionManagerHint: detectVersionManagerName(execPath),
    satisfiesMinimum: runtimeSatisfies(details),
    runtimeDetails: details,
  };
}

// ─── Diagnostic Report ──────────────────────────────────────────

/**
 * Node.js major release schedule (for EOL/maintenance warnings).
 *
 * Source: https://github.com/nodejs/release#release-schedule
 * Only tracks currently relevant release lines.
 */
const NODE_RELEASE_SCHEDULE: ReadonlyArray<{
  major: number;
  /** Start of maintenance phase (reduced support). */
  maintenanceStart: string;
  /** End of life — no more updates. */
  eol: string;
  /** Display label for messaging. */
  label: string;
}> = [
  {
    major: 22,
    maintenanceStart: "2025-10-21",
    eol: "2027-04-30",
    label: "Node 22 LTS",
  },
];

/** The recommended Node.js major version for new installs. */
const RECOMMENDED_NODE_MAJOR = 24;

/**
 * Build user-facing diagnostic notes from Node.js runtime diagnostics.
 * Returns an empty array when everything looks healthy.
 *
 * @param diag - collected diagnostics
 * @param now  - current date (injectable for testing)
 */
export function buildNodeRuntimeWarnings(
  diag: NodeRuntimeDiagnostics,
  now: Date = new Date(),
): string[] {
  const warnings: string[] = [];

  // ── Minimum version check ──
  // This should rarely trigger (startup gate catches it first),
  // but guards against edge cases like running doctor via a
  // different code path.
  if (!diag.satisfiesMinimum) {
    warnings.push(
      `Node ${diag.version ?? "unknown"} does not meet the minimum requirement (>=22.14.0).`,
    );
    warnings.push("Upgrade Node: https://nodejs.org/en/download");
    return warnings;
  }

  // ── EOL / maintenance proximity warnings ──
  if (diag.major !== null) {
    const schedule = NODE_RELEASE_SCHEDULE.find((s) => s.major === diag.major);
    if (schedule) {
      const eolDate = new Date(schedule.eol);
      const maintenanceDate = new Date(schedule.maintenanceStart);
      const nowMs = now.getTime();

      if (nowMs >= eolDate.getTime()) {
        // Already past EOL
        warnings.push(
          `${schedule.label} reached end-of-life on ${schedule.eol} and no longer receives security updates.`,
        );
        warnings.push(
          `Upgrade to Node ${RECOMMENDED_NODE_MAJOR} (recommended): https://nodejs.org/en/download`,
        );
      } else if (nowMs >= maintenanceDate.getTime()) {
        // In maintenance phase — still supported but winding down
        const monthsLeft = Math.max(
          1,
          Math.round((eolDate.getTime() - nowMs) / (30 * 24 * 60 * 60 * 1000)),
        );
        warnings.push(
          `${schedule.label} is in maintenance mode (EOL ${schedule.eol}, ~${monthsLeft} months remaining).`,
        );
        warnings.push(
          `Consider upgrading to Node ${RECOMMENDED_NODE_MAJOR} for the latest features and longer support.`,
        );
      }
    }

    // ── Recommended version nudge ──
    // Only shown when not already warned about EOL/maintenance,
    // and only when running an older-than-recommended LTS.
    if (warnings.length === 0 && diag.major < RECOMMENDED_NODE_MAJOR) {
      warnings.push(
        `Node ${diag.major} is supported, but Node ${RECOMMENDED_NODE_MAJOR} is recommended for best performance and longest support window.`,
      );
    }
  }

  return warnings;
}

/**
 * Build a one-line Node.js runtime summary for Doctor output.
 *
 * Example: "Node 24.14.0 · /home/user/.nvm/versions/node/v24.14.0/bin/node · nvm"
 */
export function buildNodeRuntimeSummary(diag: NodeRuntimeDiagnostics): string {
  const parts: string[] = [];

  // Version
  parts.push(`Node ${diag.version ?? "unknown"}`);

  // Executable path (shortened for readability)
  if (diag.execPath) {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
    let displayPath = diag.execPath;
    if (homeDir && displayPath.startsWith(homeDir)) {
      displayPath = "~" + displayPath.slice(homeDir.length);
    }
    parts.push(displayPath);
  }

  // Version manager
  if (diag.versionManagerHint) {
    parts.push(`via ${diag.versionManagerHint}`);
  } else if (diag.versionManaged) {
    parts.push("via version manager");
  } else {
    parts.push("system install");
  }

  return parts.join(" · ");
}

// ─── Doctor Contribution Entry Point ────────────────────────────

/**
 * Doctor health contribution: Node.js runtime information.
 *
 * Always runs (Node is the only supported runtime). Emits:
 *   - A runtime summary note (version, path, manager)
 *   - Optional warnings for EOL proximity or upgrade suggestions
 *
 * This contribution intentionally does not duplicate the startup
 * version gate (runtime-guard.ts assertSupportedRuntime) — it
 * provides diagnostic context and forward-looking advice.
 */
export async function noteNodeRuntime(): Promise<void> {
  const diag = collectNodeRuntimeDiagnostics();

  // Always show the runtime summary
  const summary = buildNodeRuntimeSummary(diag);
  note(summary, "Node.js runtime");

  // Show warnings when applicable
  const warnings = buildNodeRuntimeWarnings(diag);
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Node.js runtime advisory");
  }
}
