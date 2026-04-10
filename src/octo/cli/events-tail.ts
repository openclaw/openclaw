// Octopus Orchestrator -- `openclaw octo events --tail` CLI command (M1-23)
//
// Streams events from the append-only event log to stdout.
// One event per line in human format (default) or JSON-per-line (--json).
//
// Architecture:
//   runOctoEventsTail  -- entry point: wires AbortController, calls EventLogService.tail
//   formatEventHuman   -- renders a single event as a human-readable line
//   formatEventJson    -- renders a single event as a JSON line
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { EventLogFilter, EventLogService } from "../head/event-log.ts";
import type { EventEnvelope } from "../wire/events.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface OctoEventsTailOptions {
  /** Filter by entity_type (e.g. "arm", "grip", "mission"). */
  entity?: EventEnvelope["entity_type"];
  /** Filter by entity_id. */
  entityId?: string;
  /** Filter by event_type (e.g. "arm.created"). */
  type?: EventEnvelope["event_type"];
  /** Emit JSON-per-line instead of human-readable format. */
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────────────

/** Format a single event envelope as a human-readable line. */
export function formatEventHuman(envelope: EventEnvelope): string {
  return `${envelope.ts} [${envelope.entity_type}/${envelope.entity_id}] ${envelope.event_type} actor=${envelope.actor}`;
}

/** Format a single event envelope as a JSON line. */
export function formatEventJson(envelope: EventEnvelope): string {
  return JSON.stringify(envelope);
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Entry point called by the CLI dispatcher. Streams events to `out` until
 * `signal` is aborted (typically via SIGINT / Ctrl+C).
 *
 * Returns a Promise that resolves to exit code 0 on clean abort, or 1 on
 * error.
 */
export async function runOctoEventsTail(
  eventLog: EventLogService,
  opts: OctoEventsTailOptions,
  signal: AbortSignal,
  out: { write: (s: string) => void } = process.stdout,
): Promise<number> {
  const filter: EventLogFilter = {};
  if (opts.entity !== undefined) {
    filter.entity_type = opts.entity;
  }
  if (opts.entityId !== undefined) {
    filter.entity_id = opts.entityId;
  }
  if (opts.type !== undefined) {
    filter.event_type = opts.type;
  }

  const formatter = opts.json ? formatEventJson : formatEventHuman;

  try {
    await eventLog.tail(
      filter,
      (envelope: EventEnvelope) => {
        out.write(formatter(envelope) + "\n");
      },
      { signal, pollIntervalMs: 250 },
    );
  } catch (err: unknown) {
    if (err instanceof Error && /aborted before start/.test(err.message)) {
      return 1;
    }
    throw err;
  }

  return 0;
}
