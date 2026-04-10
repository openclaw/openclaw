// Octopus Orchestrator — `openclaw octo init` CLI command (M2-17)
//
// Setup wizard: creates state directory, initializes SQLite registry,
// runs doctor checks, and reports results.
//
// Architecture:
//   runOctoInit — creates state dir, opens registry, runs doctor, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  closeOctoRegistry,
  openOctoRegistry,
  resolveOctoRegistryPath,
} from "../head/storage/migrate.ts";
import { type DoctorCheck, formatDoctorOutput, runDoctorChecks } from "./doctor.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface InitOptions {
  yes?: boolean;
  json?: boolean;
  stateDir?: string;
}

export interface InitResult {
  stateDirCreated: boolean;
  stateDirPath: string;
  registryInitialized: boolean;
  registryPath: string;
  doctorChecks: DoctorCheck[];
  hasCriticalFailures: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function resolveStateDir(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const envOverride = process.env.OPENCLAW_STATE_DIR?.trim();
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }
  return path.join(homedir(), ".openclaw");
}

// ──────────────────────────────────────────────────────────────────────────
// Core logic
// ──────────────────────────────────────────────────────────────────────────

/** Run the init sequence: create state dir, init registry, run doctor. */
export function executeInit(opts: InitOptions): InitResult {
  const stateDir = resolveStateDir(opts.stateDir);
  const octoDir = path.join(stateDir, "octo");

  // 1. Create state directory if missing
  const stateDirExisted = existsSync(octoDir);
  if (!stateDirExisted) {
    mkdirSync(octoDir, { recursive: true, mode: 0o700 });
  }

  // 2. Initialize SQLite registry
  const registryPath = resolveOctoRegistryPath(
    opts.stateDir ? { OPENCLAW_STATE_DIR: opts.stateDir } : undefined,
  );
  const db = openOctoRegistry({ path: registryPath });
  closeOctoRegistry(db);

  // 3. Run doctor checks
  const doctorChecks = runDoctorChecks({
    registryPath,
  });

  const hasCriticalFailures = doctorChecks.some(
    (c) => c.severity === "critical" || c.severity === "error",
  );

  return {
    stateDirCreated: !stateDirExisted,
    stateDirPath: octoDir,
    registryInitialized: true,
    registryPath,
    doctorChecks,
    hasCriticalFailures,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Format — human-readable output
// ──────────────────────────────────────────────────────────────────────────

/** Format init result for human display. */
export function formatInitOutput(result: InitResult): string {
  const lines: string[] = [];

  lines.push("Octopus Init");
  lines.push("============");
  lines.push("");

  if (result.stateDirCreated) {
    lines.push(`Created state directory: ${result.stateDirPath}`);
  } else {
    lines.push(`State directory exists: ${result.stateDirPath}`);
  }

  lines.push(`Registry initialized: ${result.registryPath}`);
  lines.push("");

  // Append doctor output
  lines.push(formatDoctorOutput(result.doctorChecks));

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success, 1 = critical failure). */
export function runOctoInit(
  opts: InitOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const result = executeInit(opts);

  if (opts.json) {
    out.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    out.write(formatInitOutput(result));
  }

  return result.hasCriticalFailures ? 1 : 0;
}
