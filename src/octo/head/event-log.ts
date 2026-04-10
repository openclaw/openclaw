// Octopus Orchestrator — EventLogService append + ULID (M1-03)
//                       + replay (M1-04) + tail (M1-06)
//
// Append-only JSONL event log at `<stateDir>/octo/events.jsonl`. Every
// state transition in the Octopus control plane is written here as a
// validated EventEnvelope (see src/octo/wire/events.ts). Replay (M1-04)
// and tail (M1-06) read this same file.
//
// Context docs:
//   - LLD §Event Schema — envelope shape and field semantics
//   - LLD §Event Schema Versioning and Migration — schema_version lifecycle
//   - DECISIONS.md OCTO-DEC-018 — additive event vocabulary rule
//   - DECISIONS.md OCTO-DEC-010 — SQLite + JSONL storage paths
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins, `@sinclair/typebox`, and relative imports
//   inside `src/octo/` are permitted. No external ULID dependency — a
//   small implementation is inlined below per the spec at
//   github.com/ulid/spec.
//
// ULID monotonicity:
//   The `generateUlid` helper keeps a per-process `lastUlidMs` and
//   `lastUlidRandom` buffer. When called multiple times within the same
//   millisecond, the random buffer is incremented as a big-endian
//   integer so the resulting ULID sorts strictly after the previous one.
//   This is load-bearing: the event log REQUIRES time-ordered IDs for
//   correct replay.
//
// POSIX append atomicity:
//   `fs/promises.appendFile` uses O_APPEND semantics on POSIX, which is
//   atomic for writes smaller than PIPE_BUF (typically 4096 bytes — well
//   above any single-event JSON line we produce). On Windows the guarantee
//   is weaker; cross-platform exact-once-write-or-fail is deferred to a
//   later milestone.

import { randomFillSync } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Value } from "@sinclair/typebox/value";
import { EventEnvelopeSchema, type EventEnvelope } from "../wire/events.ts";

const EVENT_LOG_SUBPATH = path.join("octo", "events.jsonl");
const EVENT_LOG_DIR_MODE = 0o700;

// ══════════════════════════════════════════════════════════════════════════
// State-dir resolver (sibling of resolveOctoRegistryPath in storage/migrate.ts)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the absolute path to the Octopus event log JSONL file.
 *
 * Honours `OPENCLAW_STATE_DIR` when set (trimmed, non-empty); otherwise
 * falls back to `<home>/.openclaw`. Appends `octo/events.jsonl`.
 */
export function resolveEventLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = override && override.length > 0 ? override : path.join(homedir(), ".openclaw");
  return path.join(stateDir, EVENT_LOG_SUBPATH);
}

// ══════════════════════════════════════════════════════════════════════════
// ULID generator — Crockford base32, monotonic within ms.
//
// Spec: github.com/ulid/spec
//   26 chars total = 10 chars timestamp (48-bit) + 16 chars random (80-bit)
//   Alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ (no I, L, O, U)
//   Lex-sortable when generated in time order.
// ══════════════════════════════════════════════════════════════════════════

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RANDOM_BYTES = 10; // 80 bits
const ULID_TS_CHARS = 10;
const ULID_RANDOM_CHARS = 16;

// Encode a 48-bit unsigned integer (in JS number form; safe up to 2^53)
// as 10 Crockford base32 characters, big-endian.
function encodeTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new Error(`generateUlid: timestamp out of range: ${ms}`);
  }
  let value = ms;
  const chars: string[] = Array.from({ length: ULID_TS_CHARS }, () => "");
  for (let i = ULID_TS_CHARS - 1; i >= 0; i--) {
    const mod = value % 32;
    chars[i] = CROCKFORD_BASE32[mod]!;
    value = (value - mod) / 32;
  }
  return chars.join("");
}

// Encode an 80-bit random buffer (10 bytes) as 16 Crockford base32 chars.
// We treat the 10 bytes as a big-endian 80-bit integer and emit 5 bits at
// a time, most-significant first.
function encodeRandom(bytes: Buffer): string {
  if (bytes.length !== ULID_RANDOM_BYTES) {
    throw new Error(
      `generateUlid: random buffer must be ${ULID_RANDOM_BYTES} bytes, got ${bytes.length}`,
    );
  }
  // 80 bits -> 16 * 5-bit groups. Walk bit-by-bit from MSB.
  const chars: string[] = Array.from({ length: ULID_RANDOM_CHARS }, () => "");
  for (let i = 0; i < ULID_RANDOM_CHARS; i++) {
    const bitOffset = i * 5;
    const byteIndex = Math.floor(bitOffset / 8);
    const bitInByte = bitOffset % 8;
    // Read 5 bits starting at bitInByte within bytes[byteIndex], possibly
    // spanning into bytes[byteIndex+1].
    const hi = bytes[byteIndex] ?? 0;
    const lo = bytes[byteIndex + 1] ?? 0;
    const combined = (hi << 8) | lo; // 16 bits
    const shift = 16 - bitInByte - 5;
    const group = (combined >> shift) & 0x1f;
    chars[i] = CROCKFORD_BASE32[group]!;
  }
  return chars.join("");
}

// Increment a big-endian byte buffer as if it were an unsigned integer.
// Throws if the buffer overflows (all 0xff -> carry out of MSB).
function incrementBuffer(buf: Buffer): void {
  for (let i = buf.length - 1; i >= 0; i--) {
    const next = (buf[i] ?? 0) + 1;
    if (next <= 0xff) {
      buf[i] = next;
      return;
    }
    buf[i] = 0;
  }
  throw new Error(
    "generateUlid: random buffer overflow within a single millisecond (2^80 values exhausted)",
  );
}

let lastUlidMs = -1;
const lastUlidRandom = Buffer.alloc(ULID_RANDOM_BYTES);

/**
 * Generate a monotonic 26-character Crockford-base32 ULID.
 *
 * `now` may be passed to force a specific millisecond (used by tests to
 * exercise the same-millisecond monotonicity path deterministically).
 */
export function generateUlid(now: number = Date.now()): string {
  if (now === lastUlidMs) {
    incrementBuffer(lastUlidRandom);
  } else {
    randomFillSync(lastUlidRandom);
    lastUlidMs = now;
  }
  return encodeTimestamp(now) + encodeRandom(lastUlidRandom);
}

// ══════════════════════════════════════════════════════════════════════════
// EventLogService
// ══════════════════════════════════════════════════════════════════════════

export interface EventLogServiceOptions {
  /** Override the events.jsonl path. Tests pass a temp path here. */
  path?: string;
}

/**
 * Shape of the input accepted by `EventLogService.append`. Identical to
 * `EventEnvelope` except the service generates `event_id` (ULID) and
 * defaults `ts` to `new Date().toISOString()` when omitted.
 */
export interface AppendInput {
  schema_version: number;
  entity_type: EventEnvelope["entity_type"];
  entity_id: string;
  event_type: EventEnvelope["event_type"];
  ts?: string;
  actor: string;
  causation_id?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════════════
// Replay + tail supporting types (M1-04, M1-06)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Filter applied to events during replay or tail. Any provided field must
 * match exactly; an empty or missing filter matches every event.
 */
export interface EventLogFilter {
  entity_type?: EventEnvelope["entity_type"];
  entity_id?: string;
  event_type?: EventEnvelope["event_type"];
}

/**
 * Migration transform — upgrades a single event envelope one schema
 * version forward (v_n → v_{n+1}). The returned envelope must have
 * `schema_version` incremented by exactly one. M1-05 will populate the
 * registry; M1-04 just consumes it.
 */
export type MigrationFn = (envelope: EventEnvelope) => EventEnvelope;

/** Handler invoked once per event during replay. */
export type EventLogReplayHandler = (envelope: EventEnvelope) => void | Promise<void>;

/** Handler invoked once per event during tail. */
export type EventLogTailHandler = (envelope: EventEnvelope) => void | Promise<void>;

export interface EventLogReplayOptions {
  /** Optional filter applied before the handler is called. */
  filter?: EventLogFilter;
  /**
   * Migration table keyed by source schema_version. Each entry upgrades
   * a v_n event to v_{n+1}. Replay walks the chain until the envelope
   * reaches `currentSchemaVersion`.
   */
  migrations?: Readonly<Record<number, MigrationFn>>;
  /**
   * The current schema version to upgrade events to. Defaults to the
   * highest registered migration target (max key + 1), or `1` when no
   * migrations are registered.
   */
  currentSchemaVersion?: number;
}

export interface EventLogTailOptions {
  /** Polling interval in ms. Default 250. */
  pollIntervalMs?: number;
  /** AbortSignal to cleanly stop the tail. */
  signal?: AbortSignal;
  /**
   * Whether to read existing content before tailing new appends.
   * Default false (only stream new events).
   */
  fromBeginning?: boolean;
}

function matchesFilter(envelope: EventEnvelope, filter: EventLogFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.entity_type !== undefined && envelope.entity_type !== filter.entity_type) {
    return false;
  }
  if (filter.entity_id !== undefined && envelope.entity_id !== filter.entity_id) {
    return false;
  }
  if (filter.event_type !== undefined && envelope.event_type !== filter.event_type) {
    return false;
  }
  return true;
}

function parseEnvelopeLine(line: string, lineNumber: number): EventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`EventLogService: malformed JSON on line ${lineNumber}: ${msg}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`EventLogService: line ${lineNumber} is not a JSON object`);
  }
  return parsed as EventEnvelope;
}

function applyMigrations(
  envelope: EventEnvelope,
  migrations: Readonly<Record<number, MigrationFn>>,
  currentSchemaVersion: number,
  lineNumber: number,
): EventEnvelope {
  let cur = envelope;
  const seen = new Set<number>();
  while (cur.schema_version < currentSchemaVersion) {
    const from = cur.schema_version;
    if (seen.has(from)) {
      throw new Error(
        `EventLogService: migration loop detected at line ${lineNumber} (schema_version ${from})`,
      );
    }
    seen.add(from);
    const migrate = migrations[from];
    if (!migrate) {
      throw new Error(
        `EventLogService: missing migration on line ${lineNumber} from schema_version ${from} to ${from + 1} (target ${currentSchemaVersion})`,
      );
    }
    const next = migrate(cur);
    if (next.schema_version !== from + 1) {
      throw new Error(
        `EventLogService: migration on line ${lineNumber} from schema_version ${from} produced schema_version ${next.schema_version}, expected ${from + 1}`,
      );
    }
    cur = next;
  }
  return cur;
}

function validateEnvelope(envelope: EventEnvelope, lineNumber: number): void {
  if (!Value.Check(EventEnvelopeSchema, envelope)) {
    const errors = [...Value.Errors(EventEnvelopeSchema, envelope)].map(
      (e) => `${e.path}: ${e.message}`,
    );
    throw new Error(`EventLogService: invalid event on line ${lineNumber}: ${errors.join("; ")}`);
  }
}

function resolveCurrentSchemaVersion(
  migrations: Readonly<Record<number, MigrationFn>>,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const keys = Object.keys(migrations).map((k) => Number.parseInt(k, 10));
  if (keys.length === 0) {
    return 1;
  }
  return Math.max(...keys) + 1;
}

export class EventLogService {
  public readonly path: string;

  constructor(opts: EventLogServiceOptions = {}) {
    this.path = opts.path ?? resolveEventLogPath();
  }

  /**
   * Append a validated event envelope to the JSONL log. Returns the
   * composed envelope (including the service-generated `event_id`).
   *
   * Throws if the composed envelope fails TypeBox validation against
   * `EventEnvelopeSchema`.
   */
  async append(input: AppendInput): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      event_id: generateUlid(),
      schema_version: input.schema_version,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: input.event_type,
      ts: input.ts ?? new Date().toISOString(),
      actor: input.actor,
      ...(input.causation_id != null ? { causation_id: input.causation_id } : {}),
      ...(input.correlation_id != null ? { correlation_id: input.correlation_id } : {}),
      payload: input.payload,
    };

    if (!Value.Check(EventEnvelopeSchema, envelope)) {
      const errors = [...Value.Errors(EventEnvelopeSchema, envelope)].map(
        (e) => `${e.path}: ${e.message}`,
      );
      throw new Error(`EventLogService.append: invalid event: ${errors.join("; ")}`);
    }

    const parent = path.dirname(this.path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: EVENT_LOG_DIR_MODE });
    }

    await appendFile(this.path, `${JSON.stringify(envelope)}\n`, "utf8");
    return envelope;
  }

  /**
   * Replay the event log from the beginning, calling `handler` for each
   * event in file order (which is ULID-monotonic because `append` writes
   * ULIDs in monotonic order). Returns the count of events the handler
   * was called on (post-filter).
   *
   * Streaming: uses `node:readline` over a file read stream so that a
   * very large log does not need to be materialized in memory.
   *
   * Schema versioning: events whose `schema_version` is lower than
   * `opts.currentSchemaVersion` are walked through the migration chain
   * in `opts.migrations` until they reach the current version. A
   * missing migration in the chain is a fatal error — the operator is
   * expected to have the full migration table registered when calling
   * replay. If no migrations are provided and `currentSchemaVersion`
   * defaults to 1, any v1 events pass through unchanged.
   *
   * Empty or missing log file: returns 0 (not an error — it is the
   * empty replay case).
   */
  async replay(handler: EventLogReplayHandler, opts: EventLogReplayOptions = {}): Promise<number> {
    if (!existsSync(this.path)) {
      return 0;
    }

    const migrations = opts.migrations ?? {};
    const currentSchemaVersion = resolveCurrentSchemaVersion(migrations, opts.currentSchemaVersion);
    const filter = opts.filter;

    const stream = createReadStream(this.path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let lineNumber = 0;
    let processed = 0;
    try {
      for await (const rawLine of rl) {
        lineNumber++;
        if (rawLine.length === 0) {
          continue;
        }

        const raw = parseEnvelopeLine(rawLine, lineNumber);
        const migrated = applyMigrations(raw, migrations, currentSchemaVersion, lineNumber);
        validateEnvelope(migrated, lineNumber);

        if (!matchesFilter(migrated, filter)) {
          continue;
        }

        await handler(migrated);
        processed++;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return processed;
  }

  /**
   * Tail the event log, streaming new events as they are appended. The
   * handler is called once per event that matches `filter` (an empty
   * filter matches everything).
   *
   * Polling strategy: the implementation polls `fs.stat` every
   * `opts.pollIntervalMs` (default 250ms) rather than using `fs.watch`.
   * `fs.watch` is unreliable cross-platform (FSEvents on macOS can
   * coalesce / drop events, inotify on Linux has descriptor limits,
   * Windows semantics differ). Polling is simple, portable, and the
   * latency is acceptable for an operator surface.
   *
   * Partial line buffering: reads are done at byte-offset boundaries,
   * so a read may land mid-line if an appender is in the middle of a
   * write. Any trailing bytes without a newline are buffered and
   * retried on the next poll.
   *
   * File rotation / truncation: if the file size shrinks between polls
   * the offset is reset to 0 and the file is re-read from the start.
   * M1-06 does not exercise this path in tests.
   *
   * Abort: honours `opts.signal`. Rejects immediately if called with an
   * already-aborted signal; otherwise resolves cleanly the next time the
   * poll loop observes the abort.
   *
   * Not-yet-existing file: if the target path does not exist when tail
   * starts, the poll loop waits for it to appear.
   */
  async tail(
    filter: EventLogFilter,
    handler: EventLogTailHandler,
    opts: EventLogTailOptions = {},
  ): Promise<void> {
    const signal = opts.signal;
    if (signal?.aborted) {
      throw new Error("EventLogService.tail: aborted before start");
    }
    const pollIntervalMs = opts.pollIntervalMs ?? 250;
    const fromBeginning = opts.fromBeginning ?? false;

    // Establish the initial offset up-front. If the file already exists
    // and we are NOT reading from the beginning, skip past its current
    // content — only new appends will be streamed. If the file does not
    // yet exist, offset stays at 0 so its eventual content is streamed
    // as new.
    let offset = 0;
    if (!fromBeginning && existsSync(this.path)) {
      offset = statSync(this.path).size;
    }
    let buffer = "";

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve();
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        if (signal !== undefined) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });

    while (true) {
      if (signal?.aborted) {
        return;
      }

      if (!existsSync(this.path)) {
        await sleep(pollIntervalMs);
        continue;
      }

      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        await sleep(pollIntervalMs);
        continue;
      }

      if (size < offset) {
        // File rotated or truncated — re-read from start.
        offset = 0;
        buffer = "";
      }

      if (size > offset) {
        const handle = await open(this.path, "r");
        try {
          const length = size - offset;
          const buf = Buffer.alloc(length);
          await handle.read(buf, 0, length, offset);
          buffer += buf.toString("utf8");
          offset = size;
        } finally {
          await handle.close();
        }

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length === 0) {
            continue;
          }
          const raw = parseEnvelopeLine(line, -1);
          validateEnvelope(raw, -1);
          if (!matchesFilter(raw, filter)) {
            continue;
          }
          await handler(raw);
          if (signal?.aborted) {
            return;
          }
        }
      }

      if (signal?.aborted) {
        return;
      }
      await sleep(pollIntervalMs);
    }
  }
}
