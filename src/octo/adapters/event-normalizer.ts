// Octopus Orchestrator -- Event normalizer pipeline (M2-02)
//
// Bridges adapter-level AdapterEvent records into AppendInput-compatible
// records the Head's EventLogService can consume. Validates incoming events,
// stamps them with arm_id, ts, and a per-arm monotonic sequence number.
// Malformed events produce AnomalyRecord instead of throwing, so the
// adapter stream is never interrupted by bad data.
//
// See:
//   - docs/octopus-orchestrator/LLD.md, Event Normalization Pipeline
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (boundary discipline)

import type { AppendInput } from "../head/event-log.ts";
import type { CoreEventType, EventEntityType } from "../wire/events.ts";
import type { AdapterEvent } from "./base.ts";

// ──────────────────────────────────────────────────────────────────────────
// NormalizedEvent -- successfully validated + stamped adapter event
// ──────────────────────────────────────────────────────────────────────────

export interface NormalizedEvent {
  /** The arm that produced this event. */
  arm_id: string;
  /** Per-arm monotonic sequence number (0-based). */
  sequence: number;
  /** ISO 8601 timestamp derived from AdapterEvent.ts (unix ms). */
  ts: string;
  /** The original adapter event kind. */
  kind: AdapterEvent["kind"];
  /** The adapter event data payload. */
  data: Record<string, unknown>;
  /** AppendInput-compatible record ready for EventLogService.append(). */
  append_input: AppendInput;
}

// ──────────────────────────────────────────────────────────────────────────
// AnomalyRecord -- produced when an AdapterEvent is malformed
// ──────────────────────────────────────────────────────────────────────────

export interface AnomalyRecord {
  /** The arm that produced (or was expected to produce) this event. */
  arm_id: string;
  /** Per-arm monotonic sequence number (still incremented for anomalies). */
  sequence: number;
  /** When the anomaly was detected (ISO 8601). */
  detected_at: string;
  /** Human-readable description of what went wrong. */
  reason: string;
  /** The raw input that failed validation, preserved for diagnostics. */
  raw: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// NormalizationResult -- discriminated union returned by normalize()
// ──────────────────────────────────────────────────────────────────────────

export type NormalizationResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; anomaly: AnomalyRecord };

// ──────────────────────────────────────────────────────────────────────────
// Mapping: AdapterEvent.kind -> CoreEventType + EventEntityType
// ──────────────────────────────────────────────────────────────────────────

const VALID_KINDS = new Set<string>(["output", "state", "cost", "error", "completion"]);

const KIND_TO_EVENT_TYPE: Record<string, CoreEventType> = {
  output: "arm.active",
  state: "arm.active",
  cost: "arm.active",
  error: "arm.failed",
  completion: "arm.completed",
};

const ENTITY_TYPE: EventEntityType = "arm";
const SCHEMA_VERSION = 1;

// ──────────────────────────────────────────────────────────────────────────
// EventNormalizer
// ──────────────────────────────────────────────────────────────────────────

export class EventNormalizer {
  /** Per-arm sequence counters. */
  private readonly sequences = new Map<string, number>();

  /** Get the next sequence number for an arm (0-based, monotonic). */
  private nextSequence(armId: string): number {
    const current = this.sequences.get(armId) ?? 0;
    this.sequences.set(armId, current + 1);
    return current;
  }

  /**
   * Validate and normalize a raw AdapterEvent into a NormalizedEvent (with
   * an AppendInput ready for EventLogService.append), or produce an
   * AnomalyRecord if the event is malformed.
   *
   * Never throws -- adapter streams must not crash on bad data.
   */
  normalize(armId: string, raw: unknown): NormalizationResult {
    const seq = this.nextSequence(armId);

    // --- Structural validation ---
    if (typeof raw !== "object" || raw === null) {
      return {
        ok: false,
        anomaly: {
          arm_id: armId,
          sequence: seq,
          detected_at: new Date().toISOString(),
          reason: "event is not an object",
          raw,
        },
      };
    }

    const obj = raw as Record<string, unknown>;

    // Validate kind
    if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) {
      return {
        ok: false,
        anomaly: {
          arm_id: armId,
          sequence: seq,
          detected_at: new Date().toISOString(),
          reason: `invalid or missing kind: ${JSON.stringify(obj.kind)}`,
          raw,
        },
      };
    }

    // Validate ts
    if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts) || obj.ts < 0) {
      return {
        ok: false,
        anomaly: {
          arm_id: armId,
          sequence: seq,
          detected_at: new Date().toISOString(),
          reason: `invalid or missing ts: ${JSON.stringify(obj.ts)}`,
          raw,
        },
      };
    }

    // Validate data
    if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) {
      return {
        ok: false,
        anomaly: {
          arm_id: armId,
          sequence: seq,
          detected_at: new Date().toISOString(),
          reason: `invalid or missing data: expected object, got ${Array.isArray(obj.data) ? "array" : typeof obj.data}`,
          raw,
        },
      };
    }

    // --- Event is valid: stamp and convert ---
    const kind = obj.kind as AdapterEvent["kind"];
    const ts = new Date(obj.ts).toISOString();
    const data = obj.data as Record<string, unknown>;

    const appendInput: AppendInput = {
      schema_version: SCHEMA_VERSION,
      entity_type: ENTITY_TYPE,
      entity_id: armId,
      event_type: KIND_TO_EVENT_TYPE[kind] ?? "arm.active",
      ts,
      actor: `arm:${armId}`,
      payload: {
        adapter_kind: kind,
        sequence: seq,
        ...data,
      },
    };

    const normalized: NormalizedEvent = {
      arm_id: armId,
      sequence: seq,
      ts,
      kind,
      data,
      append_input: appendInput,
    };

    return { ok: true, event: normalized };
  }
}
