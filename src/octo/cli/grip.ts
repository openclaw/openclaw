// Octopus Orchestrator -- `openclaw octo grip list/show/reassign` CLI commands (M3-09)
//
// Grip listing, detail view, and reassign stub.
// Follows the gather + format + formatJson + run pattern from status.ts.
//
// Architecture:
//   gatherGripList      -- queries the registry with filters, returns GripRecord[]
//   formatGripList      -- renders human-readable table
//   formatGripListJson  -- renders JSON array
//   runGripList         -- composes gather + format, writes to output, returns exit code
//
//   gatherGripShow      -- queries registry for a single grip, returns GripRecord | null
//   formatGripShow      -- renders human-readable detail view
//   formatGripShowJson  -- renders JSON snapshot
//   runGripShow         -- composes gather + format, writes to output, returns exit code
//
//   runGripReassign     -- stub, returns "not yet implemented"
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { GripFilter, GripRecord, RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface GripListOptions {
  mission?: string;
  status?: string;
  arm?: string;
  json?: boolean;
}

export interface GripShowOptions {
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Grip list -- gather
// ──────────────────────────────────────────────────────────────────────────

/** Gathers grip records from the registry, applying optional filters. */
export function gatherGripList(registry: RegistryService, opts: GripListOptions): GripRecord[] {
  const filter: GripFilter = {};
  if (opts.mission !== undefined) {
    filter.mission_id = opts.mission;
  }
  if (opts.status !== undefined) {
    filter.status = opts.status;
  }
  if (opts.arm !== undefined) {
    filter.assigned_arm_id = opts.arm;
  }
  return registry.listGrips(filter);
}

// ──────────────────────────────────────────────────────────────────────────
// Grip list -- format (human-readable table)
// ──────────────────────────────────────────────────────────────────────────

/** Formats grip records for human display as a table. */
export function formatGripList(grips: GripRecord[]): string {
  const lines: string[] = [];

  if (grips.length === 0) {
    lines.push("No grips found.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `${"GRIP_ID".padEnd(20)} ${"MISSION".padEnd(20)} ${"TYPE".padEnd(14)} ${"STATUS".padEnd(12)} ${"PRIORITY".padEnd(10)} ARM`,
  );
  lines.push("-".repeat(96));

  for (const g of grips) {
    lines.push(
      `${g.grip_id.padEnd(20)} ${g.mission_id.padEnd(20)} ${g.type.padEnd(14)} ${g.status.padEnd(12)} ${String(g.priority).padEnd(10)} ${g.assigned_arm_id ?? "-"}`,
    );
  }

  lines.push("");
  lines.push(`${grips.length} grip(s) total`);
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Grip list -- format (JSON)
// ──────────────────────────────────────────────────────────────────────────

/** Formats grip records as JSON. */
export function formatGripListJson(grips: GripRecord[]): string {
  return JSON.stringify(grips, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Grip list -- entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point for grip list. Returns exit code (0 = success). */
export function runGripList(
  registry: RegistryService,
  opts: GripListOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const grips = gatherGripList(registry, opts);
  const output = opts.json ? formatGripListJson(grips) : formatGripList(grips);
  out.write(output);
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Grip show -- gather
// ──────────────────────────────────────────────────────────────────────────

/** Gathers a single grip from the registry. Returns null if not found. */
export function gatherGripShow(registry: RegistryService, gripId: string): GripRecord | null {
  return registry.getGrip(gripId);
}

// ──────────────────────────────────────────────────────────────────────────
// Grip show -- format (human-readable detail)
// ──────────────────────────────────────────────────────────────────────────

function formatField(label: string, value: string | number | boolean | null | undefined): string {
  const display = value === null || value === undefined ? "-" : String(value);
  return `  ${label.padEnd(18)} ${display}`;
}

function formatTimestamp(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) {
    return "-";
  }
  return new Date(epochMs).toISOString();
}

/** Formats the grip detail for human display. */
export function formatGripShow(grip: GripRecord): string {
  const lines: string[] = [];

  lines.push(`Grip: ${grip.grip_id}`);
  lines.push("=".repeat(40));
  lines.push("");

  lines.push(formatField("Status:", grip.status));
  lines.push(formatField("Mission:", grip.mission_id));
  lines.push(formatField("Type:", grip.type));
  lines.push(formatField("Priority:", grip.priority));
  lines.push(formatField("Assigned arm:", grip.assigned_arm_id));
  lines.push(formatField("Input ref:", grip.input_ref));
  lines.push(formatField("Result ref:", grip.result_ref));
  lines.push(formatField("Timeout (s):", grip.timeout_s));
  lines.push(formatField("Side-effecting:", grip.side_effecting));
  lines.push(formatField("Idempotency key:", grip.idempotency_key));
  lines.push("");

  lines.push("Timestamps:");
  lines.push(formatField("  Created:", formatTimestamp(grip.created_at)));
  lines.push(formatField("  Updated:", formatTimestamp(grip.updated_at)));
  lines.push(formatField("  Version:", grip.version));
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Grip show -- format (JSON)
// ──────────────────────────────────────────────────────────────────────────

/** Formats the grip detail as JSON. */
export function formatGripShowJson(grip: GripRecord): string {
  return JSON.stringify(grip, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Grip show -- entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point for grip show. Returns exit code (0 = success, 1 = not found). */
export function runGripShow(
  registry: RegistryService,
  gripId: string,
  opts: GripShowOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const grip = gatherGripShow(registry, gripId);
  if (!grip) {
    out.write(`Error: unknown grip_id "${gripId}"\n`);
    return 1;
  }
  const output = opts.json ? formatGripShowJson(grip) : formatGripShow(grip);
  out.write(output);
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Grip reassign -- stub (M3)
// ──────────────────────────────────────────────────────────────────────────

/** Stub for grip reassignment. Full logic deferred to a later task. */
export function runGripReassign(
  _registry: RegistryService,
  _gripId: string,
  _targetArmId: string,
  out: { write: (s: string) => void } = process.stdout,
): number {
  out.write("Error: grip reassign is not yet implemented.\n");
  return 1;
}
