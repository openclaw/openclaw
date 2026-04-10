// Octopus Orchestrator — `openclaw octo arm show` CLI command (M1-19)
//
// Detailed view of a single arm: state, lease info, current grip,
// checkpoint, recent events.
//
// Architecture:
//   gatherArmShow       — queries registry + event log, returns structured data
//   formatArmShow       — renders human-readable detail view
//   formatArmShowJson   — renders JSON snapshot
//   runArmShow          — composes gather + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { EventLogService } from "../head/event-log.ts";
import type { ArmRecord, RegistryService } from "../head/registry.ts";
import type { EventEnvelope } from "../wire/events.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmShowOptions {
  json?: boolean;
}

export interface ArmShowResult {
  arm: ArmRecord;
  recent_events: EventEnvelope[];
}

// ──────────────────────────────────────────────────────────────────────────
// Gather — pure data extraction from registry + event log
// ──────────────────────────────────────────────────────────────────────────

const RECENT_EVENT_LIMIT = 20;

/** Gathers the arm detail from the registry and last 20 events. Returns null if arm not found. */
export async function gatherArmShow(
  registry: RegistryService,
  eventLog: EventLogService,
  armId: string,
): Promise<ArmShowResult | null> {
  const arm = registry.getArm(armId);
  if (!arm) {
    return null;
  }

  const allEvents: EventEnvelope[] = [];
  await eventLog.replay(
    (envelope) => {
      allEvents.push(envelope);
    },
    { filter: { entity_id: armId } },
  );

  // Take the last RECENT_EVENT_LIMIT events
  const recent_events = allEvents.slice(-RECENT_EVENT_LIMIT);

  return { arm, recent_events };
}

// ──────────────────────────────────────────────────────────────────────────
// Format — human-readable detail view
// ──────────────────────────────────────────────────────────────────────────

function formatField(label: string, value: string | number | null | undefined): string {
  const display = value === null || value === undefined ? "-" : String(value);
  return `  ${label.padEnd(18)} ${display}`;
}

function formatTimestamp(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) {
    return "-";
  }
  return new Date(epochMs).toISOString();
}

/** Formats the arm detail result for human display. */
export function formatArmShow(result: ArmShowResult): string {
  const lines: string[] = [];
  const a = result.arm;

  lines.push(`Arm: ${a.arm_id}`);
  lines.push("=".repeat(40));
  lines.push("");

  lines.push(formatField("State:", a.state));
  lines.push(formatField("Mission:", a.mission_id));
  lines.push(formatField("Node:", a.node_id));
  lines.push(formatField("Adapter:", a.adapter_type));
  lines.push(formatField("Runtime:", a.runtime_name));
  lines.push(formatField("Agent:", a.agent_id));
  lines.push(formatField("Task ref:", a.task_ref));
  lines.push(formatField("Current grip:", a.current_grip_id));
  lines.push(formatField("Checkpoint:", a.checkpoint_ref));
  lines.push(formatField("Health:", a.health_status));
  lines.push(formatField("Restart count:", a.restart_count));
  lines.push(formatField("Policy profile:", a.policy_profile));
  lines.push("");

  // Lease info
  lines.push("Lease:");
  lines.push(formatField("  Owner:", a.lease_owner));
  lines.push(formatField("  Expiry:", formatTimestamp(a.lease_expiry_ts)));
  lines.push("");

  // Timestamps
  lines.push("Timestamps:");
  lines.push(formatField("  Created:", formatTimestamp(a.created_at)));
  lines.push(formatField("  Updated:", formatTimestamp(a.updated_at)));
  lines.push(formatField("  Version:", a.version));
  lines.push("");

  // Recent events
  if (result.recent_events.length === 0) {
    lines.push("Recent Events: none");
  } else {
    lines.push(`Recent Events (${result.recent_events.length}):`);
    for (const ev of result.recent_events) {
      lines.push(`  ${ev.ts}  ${ev.event_type}  [${ev.actor}]`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format — JSON snapshot
// ──────────────────────────────────────────────────────────────────────────

/** Formats the arm detail result as JSON. */
export function formatArmShowJson(result: ArmShowResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success, 1 = not found). */
export async function runArmShow(
  registry: RegistryService,
  eventLog: EventLogService,
  armId: string,
  opts: ArmShowOptions,
  out: { write: (s: string) => void } = process.stdout,
): Promise<number> {
  const result = await gatherArmShow(registry, eventLog, armId);
  if (!result) {
    out.write(`Error: unknown arm_id "${armId}"\n`);
    return 1;
  }
  const output = opts.json ? formatArmShowJson(result) : formatArmShow(result);
  out.write(output);
  return 0;
}
