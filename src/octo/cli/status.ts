// Octopus Orchestrator — `openclaw octo status` CLI command (M1-17)
//
// Single-screen dashboard of missions, arms, grips, and claims.
// Template for M1-18..M1-23 CLI commands.
//
// Architecture:
//   gatherOctoStatus  — queries the registry, returns structured data
//   formatOctoStatus  — renders human-readable dashboard
//   formatOctoStatusJson — renders JSON snapshot
//   runOctoStatus     — composes gather + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface OctoStatusOptions {
  json?: boolean;
}

export interface OctoStatusResult {
  missions: {
    total: number;
    active: number;
    paused: number;
    completed: number;
    aborted: number;
  };
  arms: {
    total: number;
    active: number;
    idle: number;
    blocked: number;
    failed: number;
    starting: number;
  };
  grips: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  claims: {
    total: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Gather — pure data extraction from the registry
// ──────────────────────────────────────────────────────────────────────────

/** Gathers the status snapshot from the registry. Pure data -- no formatting. */
export function gatherOctoStatus(registry: RegistryService): OctoStatusResult {
  const missions = registry.listMissions();
  const arms = registry.listArms();
  const grips = registry.listGrips();
  const claims = registry.listClaims();

  return {
    missions: {
      total: missions.length,
      active: missions.filter((m) => m.status === "active").length,
      paused: missions.filter((m) => m.status === "paused").length,
      completed: missions.filter((m) => m.status === "completed").length,
      aborted: missions.filter((m) => m.status === "aborted").length,
    },
    arms: {
      total: arms.length,
      active: arms.filter((a) => a.state === "active").length,
      idle: arms.filter((a) => a.state === "idle").length,
      blocked: arms.filter((a) => a.state === "blocked").length,
      failed: arms.filter((a) => a.state === "failed").length,
      starting: arms.filter((a) => a.state === "starting").length,
    },
    grips: {
      total: grips.length,
      queued: grips.filter((g) => g.status === "queued").length,
      running: grips.filter((g) => g.status === "running").length,
      completed: grips.filter((g) => g.status === "completed").length,
      failed: grips.filter((g) => g.status === "failed").length,
    },
    claims: {
      total: claims.length,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Format — human-readable dashboard
// ──────────────────────────────────────────────────────────────────────────

function summarizeCounts(entries: [string, number][]): string {
  const nonZero = entries.filter(([, count]) => count > 0);
  if (nonZero.length === 0) {
    return "";
  }
  return ` (${nonZero.map(([label, count]) => `${count} ${label}`).join(", ")})`;
}

/** Formats the status result for human display. */
export function formatOctoStatus(result: OctoStatusResult): string {
  const lines: string[] = [];

  lines.push("Octopus Orchestrator Status");
  lines.push("===========================");
  lines.push("");

  const isEmpty =
    result.missions.total === 0 &&
    result.arms.total === 0 &&
    result.grips.total === 0 &&
    result.claims.total === 0;

  if (isEmpty) {
    lines.push("No missions, arms, grips, or claims.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `Missions:  ${result.missions.total} total${summarizeCounts([
      ["active", result.missions.active],
      ["paused", result.missions.paused],
      ["completed", result.missions.completed],
      ["aborted", result.missions.aborted],
    ])}`,
  );

  lines.push(
    `Arms:      ${result.arms.total} total${summarizeCounts([
      ["active", result.arms.active],
      ["idle", result.arms.idle],
      ["blocked", result.arms.blocked],
      ["failed", result.arms.failed],
      ["starting", result.arms.starting],
    ])}`,
  );

  lines.push(
    `Grips:     ${result.grips.total} total${summarizeCounts([
      ["queued", result.grips.queued],
      ["running", result.grips.running],
      ["completed", result.grips.completed],
      ["failed", result.grips.failed],
    ])}`,
  );

  lines.push(`Claims:    ${result.claims.total} total`);
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format — JSON snapshot
// ──────────────────────────────────────────────────────────────────────────

/** Formats the status result as JSON. */
export function formatOctoStatusJson(result: OctoStatusResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export function runOctoStatus(
  registry: RegistryService,
  opts: OctoStatusOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const result = gatherOctoStatus(registry);
  const output = opts.json ? formatOctoStatusJson(result) : formatOctoStatus(result);
  out.write(output);
  return 0;
}
