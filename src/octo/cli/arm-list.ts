// Octopus Orchestrator -- `openclaw octo arm list` CLI command (M1-18)
//
// Tabular listing of arms with filters for mission, node, and state.
// Follows the gather + format + formatJson + run pattern from status.ts.
//
// Architecture:
//   gatherArmList    -- queries the registry with filters, returns ArmRecord[]
//   formatArmList    -- renders human-readable table
//   formatArmListJson -- renders JSON array
//   runArmList       -- composes gather + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { ArmFilter, ArmRecord, RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmListOptions {
  mission?: string;
  node?: string;
  state?: string;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Gather -- pure data extraction from the registry
// ──────────────────────────────────────────────────────────────────────────

/** Gathers arm records from the registry, applying optional filters. */
export function gatherArmList(registry: RegistryService, opts: ArmListOptions): ArmRecord[] {
  const filter: ArmFilter = {};
  if (opts.mission !== undefined) {
    filter.mission_id = opts.mission;
  }
  if (opts.node !== undefined) {
    filter.node_id = opts.node;
  }
  if (opts.state !== undefined) {
    filter.state = opts.state;
  }
  return registry.listArms(filter);
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- human-readable table
// ──────────────────────────────────────────────────────────────────────────

/** Formats arm records for human display as a table. */
export function formatArmList(arms: ArmRecord[]): string {
  const lines: string[] = [];

  if (arms.length === 0) {
    lines.push("No arms found.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `${"ARM_ID".padEnd(20)} ${"MISSION".padEnd(20)} ${"NODE".padEnd(12)} ${"STATE".padEnd(10)} ${"RUNTIME".padEnd(14)} AGENT`,
  );
  lines.push("-".repeat(96));

  for (const arm of arms) {
    lines.push(
      `${arm.arm_id.padEnd(20)} ${arm.mission_id.padEnd(20)} ${arm.node_id.padEnd(12)} ${arm.state.padEnd(10)} ${arm.runtime_name.padEnd(14)} ${arm.agent_id}`,
    );
  }

  lines.push("");
  lines.push(`${arms.length} arm(s) total`);
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- JSON
// ──────────────────────────────────────────────────────────────────────────

/** Formats arm records as JSON. */
export function formatArmListJson(arms: ArmRecord[]): string {
  return JSON.stringify(arms, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export function runArmList(
  registry: RegistryService,
  opts: ArmListOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const arms = gatherArmList(registry, opts);
  const output = opts.json ? formatArmListJson(arms) : formatArmList(arms);
  out.write(output);
  return 0;
}
