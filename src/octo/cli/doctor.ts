// Octopus Orchestrator — `openclaw octo doctor` CLI command (M1-29)
//
// Health-check diagnostic tool. Runs a battery of read-only, idempotent
// checks and emits structured output with severity classification.
//
// Architecture:
//   runDoctorChecks   — runs all checks, returns structured data
//   formatDoctorOutput — renders human-readable diagnostic report
//   runOctoDoctor     — composes checks + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadOctoConfig } from "../config/loader.ts";
import { resolveEventLogPath } from "../head/event-log.ts";
import {
  closeOctoRegistry,
  openOctoRegistry,
  resolveOctoRegistryPath,
} from "../head/storage/migrate.ts";
import { TmuxManager } from "../node-agent/tmux-manager.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  severity: "ok" | "warning" | "error" | "critical";
  message: string;
  detail?: string;
}

export interface DoctorOptions {
  json?: boolean;
  registryPath?: string;
  eventLogPath?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Individual checks
// ──────────────────────────────────────────────────────────────────────────

function checkFeatureFlag(): DoctorCheck {
  try {
    const config = loadOctoConfig({}, { logger: () => {} });
    return {
      name: "feature-flag",
      severity: "ok",
      message: `octo enabled=${config.enabled}`,
    };
  } catch {
    return {
      name: "feature-flag",
      severity: "warning",
      message: "octo config not found, defaulting to disabled",
    };
  }
}

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  return override && override.length > 0 ? override : path.join(homedir(), ".openclaw");
}

function checkStatePath(): DoctorCheck {
  const stateDir = resolveStateDir();
  const octoDir = path.join(stateDir, "octo");
  const probe = path.join(octoDir, `.doctor-probe-${process.pid}`);

  try {
    mkdirSync(probe, { recursive: true });
    rmSync(probe, { recursive: true, force: true });
    return {
      name: "state-path",
      severity: "ok",
      message: `state dir writable: ${octoDir}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "state-path",
      severity: "error",
      message: `state dir not writable: ${octoDir}`,
      detail,
    };
  }
}

function checkSqliteRegistry(registryPath?: string): DoctorCheck {
  const dbPath = registryPath ?? resolveOctoRegistryPath();
  try {
    const db = openOctoRegistry({ path: dbPath });
    try {
      const stmt = db.prepare("SELECT 1");
      stmt.get();
    } finally {
      closeOctoRegistry(db);
    }
    return {
      name: "sqlite-registry",
      severity: "ok",
      message: "registry opened and responded to SELECT 1",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "sqlite-registry",
      severity: "error",
      message: "registry health check failed",
      detail,
    };
  }
}

function checkEventLog(eventLogPath?: string): DoctorCheck {
  const logPath = eventLogPath ?? resolveEventLogPath();

  if (!existsSync(logPath)) {
    return {
      name: "event-log",
      severity: "ok",
      message: "event log does not exist yet (will be created on first event)",
    };
  }

  try {
    accessSync(logPath, constants.R_OK);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "event-log",
      severity: "error",
      message: "event log exists but is not readable",
      detail,
    };
  }

  try {
    const content = readFileSync(logPath, "utf8");
    const allLines = content.split("\n");
    // Take last 10 non-empty lines
    const nonEmpty = allLines.filter((line) => line.trim().length > 0);
    const tail = nonEmpty.slice(-10);

    if (tail.length === 0) {
      return {
        name: "event-log",
        severity: "ok",
        message: "event log exists but is empty",
      };
    }

    for (let i = 0; i < tail.length; i++) {
      const line = tail[i];
      if (line !== undefined) {
        JSON.parse(line);
      }
    }

    return {
      name: "event-log",
      severity: "ok",
      message: `event log valid (checked last ${tail.length} entries)`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "event-log",
      severity: "warning",
      message: "event log contains invalid JSON (partial corruption)",
      detail,
    };
  }
}

function checkTmux(): DoctorCheck {
  const available = TmuxManager.isAvailable();
  if (available) {
    return {
      name: "tmux",
      severity: "ok",
      message: "tmux is available",
    };
  }
  return {
    name: "tmux",
    severity: "error",
    message: "tmux is not available (required for arm session management)",
  };
}

function checkAgentCeiling(): DoctorCheck {
  return {
    name: "agent-ceiling",
    severity: "ok",
    message: "ceiling enforcement deferred to M5 (placeholder check)",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API — pure data
// ──────────────────────────────────────────────────────────────────────────

/** Run all health checks. Pure data -- no output. */
export function runDoctorChecks(opts?: DoctorOptions): DoctorCheck[] {
  return [
    checkFeatureFlag(),
    checkStatePath(),
    checkSqliteRegistry(opts?.registryPath),
    checkEventLog(opts?.eventLogPath),
    checkTmux(),
    checkAgentCeiling(),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Format — human-readable diagnostic report
// ──────────────────────────────────────────────────────────────────────────

const SEVERITY_LABELS: Record<DoctorCheck["severity"], string> = {
  ok: "[OK]",
  warning: "[WARN]",
  error: "[ERR]",
  critical: "[CRIT]",
};

/** Format checks for human display. */
export function formatDoctorOutput(checks: DoctorCheck[]): string {
  const lines: string[] = [];

  lines.push("Octopus Doctor");
  lines.push("==============");
  lines.push("");

  for (const check of checks) {
    const label = SEVERITY_LABELS[check.severity];
    lines.push(`${label} ${check.name}: ${check.message}`);
    if (check.detail) {
      lines.push(`       ${check.detail}`);
    }
  }

  lines.push("");

  const errors = checks.filter((c) => c.severity === "error" || c.severity === "critical");
  if (errors.length > 0) {
    lines.push(`${errors.length} issue(s) require attention.`);
  } else {
    lines.push("All checks passed.");
  }
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point. Returns exit code: 0 if all ok/warning, 1 if any error/critical. */
export function runOctoDoctor(
  opts: DoctorOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const checks = runDoctorChecks(opts);

  if (opts.json) {
    out.write(JSON.stringify(checks, null, 2) + "\n");
  } else {
    out.write(formatDoctorOutput(checks));
  }

  const hasErrors = checks.some((c) => c.severity === "error" || c.severity === "critical");
  return hasErrors ? 1 : 0;
}
