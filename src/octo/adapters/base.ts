// Octopus Orchestrator -- Adapter base interface and types (M2-01)
//
// The adapter interface is the contract ALL 4 adapter types implement:
//   - SubagentAdapter    (structured_subagent)
//   - CliExecAdapter     (cli_exec)
//   - PtyTmuxAdapter     (pty_tmux)
//   - AcpAdapter         (structured_acp)
//
// Design notes:
//
//   1. The interface is intentionally MINIMAL. Each method has one
//      responsibility. Adapter-type-specific extensions (like `attach` for
//      PtyTmuxAdapter or `send_keys` for PTY) live on the concrete adapter
//      class, NOT on the base interface. The interface is what the
//      dispatcher/factory uses; callers that need adapter-specific features
//      cast to the concrete type.
//
//   2. stream() returns AsyncIterable<AdapterEvent> NOT an array -- it is a
//      live stream that yields events as they arrive. This is the primitive
//      the Node Agent loop consumes.
//
//   3. SessionRef is an interface (not a schema) because different adapters
//      populate different fields. The adapter_type field is always set so
//      the factory can route correctly.
//
//   4. health() returns a string (HealthStatus literal) to stay decoupled
//      from the HealthSnapshotSchema (which is a response-envelope concern,
//      not an adapter concern). The gateway handler composes the full
//      HealthSnapshot from the adapter's health string + registry data.
//
//   5. These types are ADAPTER-LAYER types, not wire schemas. The wire
//      schemas (SessionRefSchema, HealthSnapshotSchema) live in
//      ../wire/methods.ts and are response-envelope shapes for the Gateway
//      WS protocol. If downstream code needs to convert adapter types to
//      wire types, it does the mapping at the handler layer.
//
// See:
//   - docs/octopus-orchestrator/LLD.md, Runtime Adapter Interfaces
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (upstream isolation)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (adapter preference)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-037 (cli_exec adapter)

import type { ArmSpec } from "../wire/schema.ts";

// Re-export AdapterType from wire/schema.ts so consumers can import from
// the adapter layer without reaching into wire/.
export type { AdapterType } from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// SessionRef -- opaque session reference returned by spawn/resume
//
// Shape varies per adapter. The adapter_type field is always set so the
// factory / dispatcher can route correctly.
// ──────────────────────────────────────────────────────────────────────────

export interface SessionRef {
  /** Which adapter created this session. */
  adapter_type: string;
  /** The primary handle for the session (tmux name, subprocess pid, session key, etc.) */
  session_id: string;
  /** Human-readable attach command (if applicable). */
  attach_command?: string;
  /** Working directory of the session. */
  cwd: string;
  /** Additional adapter-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────
// CheckpointMeta -- checkpoint snapshot captured by adapter.checkpoint()
// ──────────────────────────────────────────────────────────────────────────

export interface CheckpointMeta {
  /** When the checkpoint was taken (unix ms). */
  ts: number;
  /** Session liveness at checkpoint time. */
  alive: boolean;
  /** Working directory at checkpoint time. */
  cwd?: string;
  /** Bytes of output captured so far. */
  output_bytes?: number;
  /** Process ID (if applicable). */
  pid?: number;
  /** Elapsed time since spawn (ms). */
  elapsed_ms?: number;
  /** Adapter-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────
// AdapterEvent -- normalized event emitted by adapter.stream()
// ──────────────────────────────────────────────────────────────────────────

export interface AdapterEvent {
  kind: "output" | "state" | "cost" | "error" | "completion";
  ts: number;
  data: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────
// AdapterError -- structured error thrown by adapters
// ──────────────────────────────────────────────────────────────────────────

/** Error codes for adapter failures. */
export type AdapterErrorCode =
  | "not_supported"
  | "spawn_failed"
  | "session_not_found"
  | "send_failed"
  | "terminated"
  | "internal";

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Type guard
// ──────────────────────────────────────────────────────────────────────────

/** Type guard: is this error an AdapterError? */
export function isAdapterError(err: unknown): err is AdapterError {
  return err instanceof AdapterError;
}

// ──────────────────────────────────────────────────────────────────────────
// Adapter -- base contract for all 4 adapter types
// ──────────────────────────────────────────────────────────────────────────

export interface Adapter {
  /** Which adapter type this is. */
  readonly type: string;

  /** Spawn a new session from an ArmSpec. Returns a session reference. */
  spawn(spec: ArmSpec): Promise<SessionRef>;

  /** Resume an existing session. Returns the (possibly updated) session reference. */
  resume(ref: SessionRef): Promise<SessionRef>;

  /**
   * Send input to a live session. Throws AdapterError("not_supported") if
   * the adapter does not support input.
   */
  send(ref: SessionRef, message: string): Promise<void>;

  /** Stream output events from the session. Yields normalized AdapterEvents. */
  stream(ref: SessionRef): AsyncIterable<AdapterEvent>;

  /** Take a checkpoint snapshot. */
  checkpoint(ref: SessionRef): Promise<CheckpointMeta>;

  /** Terminate the session. */
  terminate(ref: SessionRef): Promise<void>;

  /** Get the current health status (returns a HealthStatus literal string). */
  health(ref: SessionRef): Promise<string>;
}
