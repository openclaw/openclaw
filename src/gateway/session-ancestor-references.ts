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
const EMPTY_HISTORY = {};

type DeliveredRow = { version: number; fields: SessionRowDeltaFields; bytes: number };
const fixedFullRowBytes = new WeakMap<SessionRow, number>();

function fullRowByteLength(
  row: SessionRow,
  header: { key: string; agentId: string | undefined; version: number },
): number {
  let bytes = fixedFullRowBytes.get(row);
  if (bytes === undefined) {
    // Only version digits vary by history; remove the placeholder zero and null bytes.
    bytes =
      Buffer.byteLength(JSON.stringify({ ...header, version: 0, full: null })) -
      5 +
      Buffer.byteLength(serializeSessionRow(row));
    fixedFullRowBytes.set(row, bytes);
  }
  return bytes + String(header.version).length;
}

type DeliveredAncestor = { key: string; content: string; chars: number; revision: string };
type PreparedAncestor = {
  row: SessionRow;
  identity: string;
  content: string;
  chars: number;
  certified?: SessionRow;
};
const preparedAncestors = new WeakMap<SessionRow, PreparedAncestor>();

/** Prepare immutable viewer content once, before consulting connection delivery history. */
export function prepareSessionAncestor(row: SessionRow) {
  const cached = preparedAncestors.get(row);
  if (cached) {
    return cached;
  }
  const serialized = JSON.stringify(row.snapshotAt === undefined ? row : { ...row, snapshotAt: 0 });
  const prepared: PreparedAncestor = {
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
  #history: object = EMPTY_HISTORY;

  get history(): object {
    return this.#history;
  }

  // One transition map belongs to one synchronous invalidation, never to retained state.
  #invalidateHistory(histories?: Map<object, object>): void {
    if (this.#version === 0 && this.#rows.size === 0) {
      this.#history = EMPTY_HISTORY;
      return;
    }
    let next = histories?.get(this.#history);
    if (!next) {
      next = {};
      histories?.set(this.#history, next);
    }
    this.#history = next;
  }

  clear(cause: SessionEventRowsResetCause = "close", histories?: Map<object, object>): void {
    recordSessionEventRowReset(cause, this.#wireRows.size);
    updateSessionEventRowRetention(-this.#wireRows.size, -this.#wireBytes);
    this.#wireRows.clear();
    this.#wireBytes = 0;
    this.#rows.clear();
    this.#chars = 0;
    // Versions survive clearing, so even an empty socket may have a different history.
    this.#invalidateHistory(histories);
  }

  clearAncestors(histories?: Map<object, object>): void {
    if (this.#rows.size) {
      this.#rows.clear();
      this.#chars = 0;
      this.#invalidateHistory(histories);
    }
  }

  forget(key: string, histories?: Map<object, object>): void {
    if (this.#forget(key)) {
      this.#invalidateHistory(histories);
    }
  }

  #forget(key: string): boolean {
    let changed = false;
    for (const [identity, row] of this.#rows) {
      if (row.key === key) {
        this.#delete(identity);
        changed = true;
      }
    }
    return changed;
  }

  #delete(identity: string): void {
    const previous = this.#rows.get(identity);
    if (previous) {
      this.#chars -= previous.chars;
      this.#rows.delete(identity);
    }
  }

  #prepareRows(rows: SessionRow[], diff: ReturnType<typeof createSessionRowDeltaDiffer>) {
    const updates = new Map<string, DeliveredRow | undefined>();
    let count = this.#wireRows.size;
    let bytes = this.#wireBytes;
    let version = this.#version;
    let generations = 0;
    let evictions = 0;
    const encoded: Array<string | undefined> = [];
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
        previous.fields.fingerprints.get("sessionId") === fields.fingerprints.get("sessionId") &&
        previous.fields.fingerprints.get("lifecycleRevision") ===
          fields.fingerprints.get("lifecycleRevision");
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
      let result: SessionRowWire | undefined;
      let encoding: string | undefined;
      if (retain && previous && sameGeneration) {
        const patch = { ...header, base: previous.version, ...diff(previous.fields, fields, row) };
        const patchJSON = JSON.stringify(patch);
        const patchBytes = Buffer.byteLength(patchJSON);
        // Each serialized member needs at least `"":0,` (five bytes), plus the outer braces.
        if (patchBytes < 5 * fields.fieldCount + 1 || patchBytes < fullRowByteLength(row, header)) {
          result = patch;
          encoding = patchJSON;
        }
      }
      encoded.push(encoding);
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
      return result ?? { ...header, full: row, ...(!retain ? { retain: false as const } : {}) };
    });
    return { wire, encoded, updates, count, bytes, version, generations, evictions };
  }

  #prepareAncestors(
    rows: ReturnType<typeof prepareSessionAncestor>[],
    revision = randomUUID(),
    requireWireBaseline = false,
  ) {
    const ancestorSessions: SessionRow[] = [];
    const ancestorSessionRefs: SessionAncestorRef[] = [];
    let updates: Map<string, DeliveredAncestor | undefined> | undefined;
    for (const prepared of rows) {
      const { row, identity, content, chars } = prepared;
      const snapshotAt = row.snapshotAt;
      const previous = this.#rows.get(identity);
      if (
        previous?.content === content &&
        snapshotAt !== undefined &&
        (!requireWireBaseline || this.#wireRows.has(identity))
      ) {
        ancestorSessionRefs.push({
          key: row.key,
          sessionId: row.sessionId,
          agentId: row.agentId,
          revision: previous.revision,
          snapshotAt,
        });
        continue;
      }
      // One row per publication lets existing delta/encoding owners share their work.
      if (prepared.certified?.ancestorRevision !== revision) {
        prepared.certified = { ...row, ancestorRevision: revision };
      }
      ancestorSessions.push(prepared.certified);
      (updates ??= new Map()).set(
        identity,
        snapshotAt !== undefined && chars <= MAX_CONTENT_CHARS
          ? { key: row.key, content, chars, revision }
          : undefined,
      );
    }
    return {
      ancestorSessions,
      ...(ancestorSessionRefs.length ? { ancestorSessionRefs } : {}),
      updates,
    };
  }

  /** Equal histories include both LRU orders, byte charges, certificates and wire versions. */
  prepareDelivery(
    row: SessionRow,
    ancestors: ReturnType<typeof prepareSessionAncestor>[] | undefined,
    revision = randomUUID(),
    diff?: ReturnType<typeof createSessionRowDeltaDiffer>,
    certifyAncestors = true,
  ) {
    const ancestor = ancestors && this.#prepareAncestors(ancestors, revision, Boolean(diff));
    const rows = diff && this.#prepareRows([row, ...(ancestor?.ancestorSessions ?? [])], diff);
    return {
      ancestor,
      rows,
      key: row.key,
      certifyAncestors,
      before: this.#history,
      // A socket retains only this token, never the publication's payload or plan.
      after: {},
    };
  }

  deliver(plan: ReturnType<ConnectionSessionRows["prepareDelivery"]>): void {
    const unchanged = this.#history === plan.before;
    const { rows, ancestor } = plan;
    if (rows) {
      const previousCount = this.#wireRows.size;
      const previousBytes = this.#wireBytes;
      for (const [identity, next] of rows.updates) {
        this.#wireRows.delete(identity);
        if (next) {
          this.#wireRows.set(identity, next);
        }
      }
      this.#wireBytes = rows.bytes;
      this.#version = rows.version;
      updateSessionEventRowRetention(rows.count - previousCount, rows.bytes - previousBytes);
      recordSessionEventRowReset("generation", rows.generations);
      recordSessionEventRowReset("evicted", rows.evictions);
    }
    this.#forget(plan.key);
    if (!plan.certifyAncestors) {
      for (const row of ancestor?.ancestorSessions ?? []) {
        this.#forget(row.key);
      }
    } else if (ancestor?.updates) {
      for (const [identity, row] of ancestor.updates) {
        this.#delete(identity);
        if (row) {
          this.#rows.set(identity, row);
          this.#chars += row.chars;
        }
      }
      while (this.#rows.size > MAX_ROWS || this.#chars > MAX_CONTENT_CHARS) {
        this.#delete(this.#rows.keys().next().value!);
      }
    }
    if (this.#version === 0 && this.#rows.size === 0) {
      this.#history = EMPTY_HISTORY;
    } else {
      // Serialization can reenter delivery; changed retained state must stay separate.
      this.#history = unchanged ? plan.after : {};
    }
  }
}
