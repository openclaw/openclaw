// Octopus Orchestrator -- `openclaw octo grip abandon` CLI command
//
// Transitions a grip to the "abandoned" terminal state. Used to clean up
// orphaned grips from aborted missions or to manually cancel queued work.
//
// Architecture:
//   runGripAbandon -- validates, applies FSM transition, persists, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { EventLogService } from "../head/event-log.ts";
import { applyGripTransition, isTerminalState, type GripState } from "../head/grip-fsm.ts";
import { ConflictError, type RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface GripAbandonOptions {
  grip_id: string;
  reason?: string;
  mission?: string;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Abandon a single grip or all grips for a mission. Returns exit code. */
export async function runGripAbandon(
  registry: RegistryService,
  eventLog: EventLogService,
  opts: GripAbandonOptions,
  out: { write: (s: string) => void } = process.stdout,
  errOut: { write: (s: string) => void } = process.stderr,
): Promise<number> {
  // If --mission is provided, abandon all non-terminal grips for that mission.
  if (opts.mission) {
    const grips = registry.listGrips({ mission_id: opts.mission });
    let abandoned = 0;
    let skipped = 0;

    for (const grip of grips) {
      if (isTerminalState(grip.status as GripState)) {
        skipped++;
        continue;
      }
      try {
        const next = applyGripTransition(
          { state: grip.status, updated_at: grip.updated_at },
          "abandoned",
          { now: Date.now(), grip_id: grip.grip_id },
        );
        registry.casUpdateGrip(grip.grip_id, grip.version, {
          status: next.state,
          updated_at: next.updated_at,
        });
        abandoned++;
      } catch {
        // FSM transition not valid from this state — skip
        skipped++;
      }
    }

    if (opts.json) {
      out.write(JSON.stringify({ mission_id: opts.mission, abandoned, skipped }) + "\n");
    } else {
      out.write(
        `${abandoned} grip(s) abandoned, ${skipped} skipped (already terminal or invalid transition).\n`,
      );
    }
    return 0;
  }

  // Single grip mode.
  if (!opts.grip_id || opts.grip_id.trim().length === 0) {
    errOut.write(
      "Error: grip_id is required (or use --mission to abandon all grips for a mission)\n",
    );
    return 1;
  }

  const grip = registry.getGrip(opts.grip_id);
  if (grip === null) {
    errOut.write(`Error: grip not found: ${opts.grip_id}\n`);
    return 1;
  }

  if (isTerminalState(grip.status as GripState)) {
    errOut.write(`Error: grip ${opts.grip_id} is already in terminal state "${grip.status}"\n`);
    return 1;
  }

  try {
    const next = applyGripTransition(
      { state: grip.status, updated_at: grip.updated_at },
      "abandoned",
      { now: Date.now(), grip_id: opts.grip_id },
    );
    registry.casUpdateGrip(opts.grip_id, grip.version, {
      status: next.state,
      updated_at: next.updated_at,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      errOut.write(`Error: concurrent update on grip ${opts.grip_id}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    errOut.write(`Error: cannot abandon grip ${opts.grip_id}: ${msg}\n`);
    return 1;
  }

  await eventLog.append({
    schema_version: 1,
    entity_type: "grip",
    entity_id: opts.grip_id,
    event_type: "grip.abandoned",
    ts: new Date().toISOString(),
    actor: "cli",
    payload: {
      reason: opts.reason ?? "abandoned via CLI",
      previous_status: grip.status,
    },
  });

  if (opts.json) {
    out.write(JSON.stringify({ grip_id: opts.grip_id, status: "abandoned" }) + "\n");
  } else {
    out.write(`Grip ${opts.grip_id} abandoned.\n`);
  }
  return 0;
}
