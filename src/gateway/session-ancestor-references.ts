import { createHash, randomUUID } from "node:crypto";
import type {
  SessionAncestorRef,
  SessionRow,
} from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SESSION_ROW_DELTA_MAX_ENTRIES,
  sessionRowIdentity,
  type SessionRowWire,
} from "../../packages/gateway-protocol/src/session-row-deltas.js";
import type { SessionEventRowsResetCause } from "../infra/diagnostic-rpc-types.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import {
  recordSessionEventRowReset,
  updateSessionEventRowRetention,
} from "./session-event-row-retention.js";
import {
  prepareSessionRowDeltaFields,
  type SessionRowDeltaFields,
  type createSessionRowDeltaDiffer,
} from "./session-row-delta-fields.js";
import { serializeSessionRow } from "./session-row-serialization.js";

const MAX_ROWS = 128;
const MAX_CONTENT_CHARS = 128 * 1024;
const MAX_VECTOR_BYTES = 2 * 1024 * 1024;

type DeliveredRow = { version: number; fields: SessionRowDeltaFields; bytes: number };
const encodedRowBytes = new WeakMap<SessionRow, number>();

function rowByteLength(row: SessionRow): number {
  let bytes = encodedRowBytes.get(row);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(serializeSessionRow(row));
    encodedRowBytes.set(row, bytes);
  }
  return bytes;
}

type DeliveredAncestor = { key: string; content: string; chars: number; revision: string };
const preparedAncestors = new WeakMap<
  SessionRow,
  {
    row: SessionRow;
    identity: string;
    content: string;
    chars: number;
  }
>();

/** Prepare immutable viewer content once, before consulting connection delivery history. */
export function prepareSessionAncestor(row: SessionRow) {
  const cached = preparedAncestors.get(row);
  if (cached) {
    return cached;
  }
  const serialized = JSON.stringify(row.snapshotAt === undefined ? row : { ...row, snapshotAt: 0 });
  const prepared = {
    row,
    identity: JSON.stringify([row.agentId, row.key]),
    content: createHash("sha256").update(serialized).digest("base64url"),
    chars: serialized.length,
  };
  // Presentation replacement retires these facts; mutable callers still encode each sample.
  if (isDeeplyFrozenPlainData(row)) {
    preparedAncestors.set(row, prepared);
  }
  return prepared;
}

/** Connection-owned, bounded history of exactly the presented wire content. */
export class ConnectionSessionRows {
  readonly #rows = new Map<string, DeliveredAncestor>();
  #chars = 0;
  // Separate indexes preserve legacy ancestor admission order and wire-row LRU order.
  readonly #wireRows = new Map<string, DeliveredRow>();
  #wireBytes = 0;
  #version = 0;

  clear(cause: SessionEventRowsResetCause = "close"): void {
    recordSessionEventRowReset(cause, this.#wireRows.size);
    updateSessionEventRowRetention(-this.#wireRows.size, -this.#wireBytes);
    this.#wireRows.clear();
    this.#wireBytes = 0;
    this.clearAncestors();
  }

  clearAncestors(): void {
    this.#rows.clear();
    this.#chars = 0;
  }

  forget(key: string): void {
    for (const [identity, row] of this.#rows) {
      if (row.key === key) {
        this.#delete(identity);
      }
    }
  }

  #delete(identity: string): void {
    const previous = this.#rows.get(identity);
    if (previous) {
      this.#chars -= previous.chars;
      this.#rows.delete(identity);
    }
  }

  prepareRows(rows: SessionRow[], diff: ReturnType<typeof createSessionRowDeltaDiffer>) {
    const updates = new Map<string, DeliveredRow | undefined>();
    let count = this.#wireRows.size;
    let bytes = this.#wireBytes;
    let version = this.#version;
    let generations = 0;
    let evictions = 0;
    const bases: Array<SessionRowDeltaFields | undefined> = [];
    const update = (identity: string, next: DeliveredRow | undefined) => {
      const previous = updates.has(identity) ? updates.get(identity) : this.#wireRows.get(identity);
      count += Number(Boolean(next)) - Number(Boolean(previous));
      bytes += (next?.bytes ?? 0) - (previous?.bytes ?? 0);
      updates.delete(identity);
      updates.set(identity, next);
    };
    const wire = rows.map((row): SessionRowWire => {
      const identity = sessionRowIdentity(row.key, row.agentId);
      const fields = prepareSessionRowDeltaFields(row);
      const previous = updates.has(identity) ? updates.get(identity) : this.#wireRows.get(identity);
      const sameGeneration =
        previous &&
        previous.fields.hashes.get("sessionId") === fields.hashes.get("sessionId") &&
        previous.fields.hashes.get("lifecycleRevision") === fields.hashes.get("lifecycleRevision");
      bases.push(previous?.fields);
      const charge = 64 + 16 * fields.fieldCount + 2 * identity.length;
      let eviction: string | undefined;
      if (!previous && count === SESSION_ROW_DELTA_MAX_ENTRIES) {
        for (const candidate of this.#wireRows.keys()) {
          if (!updates.has(candidate)) {
            eviction = candidate;
            break;
          }
        }
        if (!eviction) {
          for (const [candidate, value] of updates) {
            if (value) {
              eviction = candidate;
              break;
            }
          }
        }
      }
      const evictionBytes = eviction
        ? ((updates.get(eviction) ?? this.#wireRows.get(eviction))?.bytes ?? 0)
        : 0;
      const retain = bytes - (previous?.bytes ?? 0) - evictionBytes + charge <= MAX_VECTOR_BYTES;
      const next = { version: ++version, fields, bytes: charge };
      const header = { key: row.key, agentId: row.agentId, version: next.version };
      const full = { ...header, full: row, ...(!retain ? { retain: false as const } : {}) };
      let result: SessionRowWire = full;
      if (retain && previous && sameGeneration) {
        const patch = { ...header, base: previous.version, ...diff(previous.fields, fields, row) };
        const fullBytes =
          Buffer.byteLength(JSON.stringify({ ...header, full: null })) - 4 + rowByteLength(row);
        if (Buffer.byteLength(JSON.stringify(patch)) < fullBytes) {
          result = patch;
        }
      }
      if (retain && eviction) {
        update(eviction, undefined);
        evictions++;
      }
      if (previous && !sameGeneration) {
        generations++;
      } else if (previous && !retain) {
        evictions++;
      }
      update(identity, retain ? next : undefined);
      return result;
    });
    return {
      wire,
      bases,
      key: JSON.stringify(
        wire.map((row) => [
          row.version,
          "base" in row ? row.base : null,
          "retain" in row ? row.retain : null,
        ]),
      ),
      delivered: () => {
        const previousCount = this.#wireRows.size;
        const previousBytes = this.#wireBytes;
        for (const [identity, next] of updates) {
          this.#wireRows.delete(identity);
          if (next) {
            this.#wireRows.set(identity, next);
          }
        }
        this.#wireBytes = bytes;
        this.#version = version;
        updateSessionEventRowRetention(count - previousCount, bytes - previousBytes);
        recordSessionEventRowReset("generation", generations);
        recordSessionEventRowReset("evicted", evictions);
      },
    };
  }

  prepare(rows: ReturnType<typeof prepareSessionAncestor>[], revision = randomUUID()) {
    const ancestorSessions: SessionRow[] = [];
    const ancestorSessionRefs: SessionAncestorRef[] = [];
    const deliveryKeys: string[] = [];
    let updates: Map<string, DeliveredAncestor | undefined> | undefined;
    for (const { row, identity, content, chars } of rows) {
      const snapshotAt = row.snapshotAt;
      const previous = this.#rows.get(identity);
      if (previous?.content === content && snapshotAt !== undefined) {
        deliveryKeys.push(previous.revision);
        ancestorSessionRefs.push({
          key: row.key,
          sessionId: row.sessionId,
          agentId: row.agentId,
          revision: previous.revision,
          snapshotAt,
        });
        continue;
      }
      deliveryKeys.push("");
      ancestorSessions.push({ ...row, ancestorRevision: revision });
      (updates ??= new Map()).set(
        identity,
        snapshotAt !== undefined && chars <= MAX_CONTENT_CHARS
          ? { key: row.key, content, chars, revision }
          : undefined,
      );
    }
    return {
      // The caller owns the rows and full-row revision; only baseline references vary.
      deliveryKey: JSON.stringify(deliveryKeys),
      ancestorSessions,
      ...(ancestorSessionRefs.length ? { ancestorSessionRefs } : {}),
      delivered: () => {
        if (!updates) {
          return;
        }
        for (const [identity, row] of updates) {
          this.#delete(identity);
          if (row) {
            this.#rows.set(identity, row);
            this.#chars += row.chars;
          }
        }
        while (this.#rows.size > MAX_ROWS || this.#chars > MAX_CONTENT_CHARS) {
          this.#delete(this.#rows.keys().next().value!);
        }
      },
    };
  }
}
