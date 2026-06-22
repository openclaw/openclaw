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
 *   3. EOL proximity warning — Node 22 enters maintenance Oct 2025, EOL Apr 2027
 *   4. Recommended version nudge — suggest Node 24 when running an older LTS
 *
 * Registered as a Doctor health contribution. Always runs (Node is the
 * only supported runtime), but keeps output to a single informational
 * note plus optional warnings.
 *
 * This contribution reuses infrastructure from:
 *   - src/infra/runtime-guard.ts  (parseSemver, detectRuntime, MIN_NODE)
 *   - src/daemon/runtime-paths.ts (isVersionManagedNodePath)
 */

import os from "node:os";
import process from "node:process";
import { isVersionManagedNodePath } from "../daemon/runtime-paths.js";
import {
  detectRuntime,
  parseSemver,
  runtimeSatisfies,
  type RuntimeDetails,
} from "../infra/runtime-guard.js";
import { note } from "../../packages/terminal-core/src/note.js";
import { shortenHomePath } from "../utils.js";

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
 * The marker set mirrors VERSION_MANAGER_MARKERS in daemon/runtime-paths.ts
 * (which isVersionManagedNodePath consults) so the boolean "managed" check
 * and the display name stay in sync; a runtime-paths.test assertion guards
 * against drift. Some managers map from multiple markers (e.g. fnm has a
 * classic, an XDG, and a macOS Application Support layout).
 */
const VERSION_MANAGER_NAMES: ReadonlyArray<{ marker: string; name: string }> = [
  { marker: "/.nvm/", name: "nvm" },
  { marker: "/.fnm/", name: "fnm" },
  { marker: "/.local/share/fnm/", name: "fnm" },
  { marker: "/library/application support/fnm/", name: "fnm" },
  { marker: "/.volta/", name: "volta" },
  { marker: "/.asdf/", name: "asdf" },
  { marker: "/.local/share/mise/", name: "mise" },
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
  // Normalize separators and case to mirror isVersionManagedNodePath's
  // comparison (daemon/runtime-paths.ts), so a macOS "Library/Application
  // Support/fnm" path matches the lowercase marker.
  const normalized = execPath.replace(/\\/g, "/").toLowerCase();
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
  {
    // Odd-numbered line: no Active LTS phase. Already past end-of-life.
    major: 23,
    maintenanceStart: "2025-04-01",
    eol: "2025-06-01",
    label: "Node 23",
  },
  {
    major: 24,
    maintenanceStart: "2026-10-20",
    eol: "2028-04-30",
    label: "Node 24 LTS",
  },
  {
    // Odd-numbered line: no Active LTS phase.
    major: 25,
    maintenanceStart: "2026-04-01",
    eol: "2026-06-01",
    label: "Node 25",
  },
  {
    major: 26,
    maintenanceStart: "2027-10-20",
    eol: "2029-04-30",
    label: "Node 26 LTS",
  },
];

/** The recommended Node.js major version for new installs. */
const RECOMMENDED_NODE_MAJOR = 24;

/**
 * Set of major versions tracked in NODE_RELEASE_SCHEDULE.
 * Used to distinguish "known older LTS" from "unknown/non-LTS" majors
 * when deciding whether to show an upgrade nudge.
 */
const KNOWN_RELEASE_MAJORS = new Set(NODE_RELEASE_SCHEDULE.map((s) => s.major));

/**
 * Phrase the upgrade suggestion for an end-of-life / maintenance line.
 *
 * For a runtime older than the recommended major, point at the
 * recommended LTS by number. For a runtime that is already at or newer
 * than the recommended major (e.g. an odd-numbered line entering
 * maintenance), suggesting an older numbered release would be wrong, so
 * recommend a current Active LTS line without naming an older number.
 */
function upgradeTargetPhrase(major: number): string {
  return major < RECOMMENDED_NODE_MAJOR
    ? `Node ${RECOMMENDED_NODE_MAJOR}`
    : "a current Active LTS release";
}

/** Pluralize a month count: "1 month" vs "3 months". */
function monthsLabel(n: number): string {
  return n === 1 ? "1 month" : `${n} months`;
}

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
      `Node ${diag.version ?? "unknown"} does not meet the minimum requirement (>=22.19.0).`,
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
          `Upgrade to ${upgradeTargetPhrase(diag.major)} (recommended): https://nodejs.org/en/download`,
        );
      } else if (nowMs >= maintenanceDate.getTime()) {
        // In maintenance phase — still supported but winding down
        const monthsLeft = Math.max(
          1,
          Math.round((eolDate.getTime() - nowMs) / (30 * 24 * 60 * 60 * 1000)),
        );
        warnings.push(
          `${schedule.label} is in maintenance mode (EOL ${schedule.eol}, ~${monthsLabel(monthsLeft)} remaining).`,
        );
        warnings.push(
          `Consider upgrading to ${upgradeTargetPhrase(diag.major)} for the latest features and longer support.`,
        );
      }
    }

    // ── Recommended version nudge ──
    // Only shown when:
    //   - not already warned about EOL/maintenance above
    //   - running a known older LTS (tracked in NODE_RELEASE_SCHEDULE)
    //   - NOT shown for unknown/non-LTS majors (e.g. Node 23) to avoid
    //     incorrectly labeling them as "supported"
    if (
      warnings.length === 0 &&
      diag.major < RECOMMENDED_NODE_MAJOR &&
      KNOWN_RELEASE_MAJORS.has(diag.major)
    ) {
      warnings.push(
        `Node ${diag.major} is supported, but Node ${RECOMMENDED_NODE_MAJOR} is recommended for best performance and longest support window.`,
      );
    }
  }

  return warnings;
}

/**
 * Redact a Node executable path for display in copied Doctor output.
 *
 * `shortenHomePath` only redacts the effective OpenClaw home: when
 * `OPENCLAW_HOME` points to a directory other than the OS home, a Node binary
 * under the OS home (e.g. `/home/alice/.nvm/...`) is left unchanged and would
 * leak the OS username. Apply a second pass against the OS home so the path is
 * redacted regardless of whether `OPENCLAW_HOME` is set elsewhere. Handles both
 * POSIX and Windows home boundaries.
 */
function redactNodeExecPath(execPath: string): string {
  const shortened = shortenHomePath(execPath);
  // Only attempt OS-home redaction when shortenHomePath left the path as-is
  // (i.e. it was not under the OpenClaw home), to avoid double substitution.
  if (shortened !== execPath) {
    return shortened;
  }
  const osHome = os.homedir();
  if (!osHome) {
    return shortened;
  }
  if (execPath === osHome) {
    return "~";
  }
  // POSIX paths are case-sensitive, so compare the OS-home prefix exactly.
  if (execPath.startsWith(osHome + "/")) {
    return "~" + execPath.slice(osHome.length);
  }
  // Windows paths are case-insensitive (e.g. os.homedir() may return
  // "C:\\Users\\Alice" while execPath is "c:\\users\\alice\\..."), so
  // compare the backslash-boundary prefix case-insensitively. Slice by the
  // original length to preserve the path's real casing in the redacted output.
  const winPrefix = osHome + "\\";
  if (execPath.toLowerCase().startsWith(winPrefix.toLowerCase())) {
    return "~" + execPath.slice(osHome.length);
  }
  return shortened;
}

/**
 * Build a one-line Node.js runtime summary for Doctor output.
 *
 * Example: "Node 24.14.0 · ~/.nvm/versions/node/v24.14.0/bin/node · nvm"
 */
export function buildNodeRuntimeSummary(diag: NodeRuntimeDiagnostics): string {
  const parts: string[] = [];

  // Version
  parts.push(`Node ${diag.version ?? "unknown"}`);

  // Executable path (home-redacted for readability and to avoid leaking
  // usernames). Reuse the shared shortenHomePath helper, which handles
  // both POSIX ("/") and Windows ("\\") home boundaries — the previous
  // inline "/"-only check leaked full C:\\Users\\<name>\\... paths on Windows.
  if (diag.execPath) {
    parts.push(redactNodeExecPath(diag.execPath));
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
