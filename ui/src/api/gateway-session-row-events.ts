import {
  SESSION_ROW_DELTA_MAX_ENTRIES,
  sessionRowIdentity,
} from "@openclaw/gateway-protocol/session-row-deltas";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

type RetainedRow = { version: number; row: Record<string, unknown> };
type SessionRowEvent = { event: string; payload?: unknown };

/** Stage only touched entries so an invalid later ancestor cannot advance any baseline. */
class RowTransaction {
  private readonly changes = new Map<string, RetainedRow | undefined>();
  private readonly touched = new Map<string, RetainedRow>();
  private readonly oldest;
  private count: number;

  constructor(private readonly rows: Map<string, RetainedRow>) {
    this.oldest = rows.keys();
    this.count = rows.size;
  }

  get(identity: string): RetainedRow | undefined {
    return this.changes.has(identity) ? this.changes.get(identity) : this.rows.get(identity);
  }

  set(identity: string, value: RetainedRow | undefined): void {
    if (this.get(identity)) {
      this.count--;
    }
    this.changes.set(identity, value);
    this.touched.delete(identity);
    if (value) {
      this.count++;
      this.touched.set(identity, value);
    }
    while (this.count > SESSION_ROW_DELTA_MAX_ENTRIES) {
      let candidate = this.oldest.next();
      while (!candidate.done && this.changes.has(candidate.value)) {
        candidate = this.oldest.next();
      }
      const key = candidate.done ? this.touched.keys().next().value : candidate.value;
      if (key === undefined) {
        break;
      }
      this.changes.set(key, undefined);
      this.touched.delete(key);
      this.count--;
    }
  }

  commit(): void {
    for (const identity of this.changes.keys()) {
      this.rows.delete(identity);
    }
    for (const [identity, row] of this.touched) {
      this.rows.set(identity, row);
    }
  }
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function decodeRow(value: unknown, transaction: RowTransaction): unknown {
  const wire = asNullableRecord(value);
  if (
    !wire ||
    !("full" in wire || "base" in wire || "set" in wire || "remove" in wire || "retain" in wire)
  ) {
    return value;
  }
  if (
    typeof wire.key !== "string" ||
    (wire.agentId !== undefined && typeof wire.agentId !== "string") ||
    !validVersion(wire.version)
  ) {
    throw new Error("invalid session row");
  }
  const identity = sessionRowIdentity(wire.key, wire.agentId);
  let row: Record<string, unknown>;
  if ("full" in wire) {
    const full = asNullableRecord(wire.full);
    if (
      !full ||
      full.key !== wire.key ||
      full.agentId !== wire.agentId ||
      (wire.retain !== undefined && wire.retain !== false) ||
      "base" in wire ||
      "set" in wire ||
      "remove" in wire
    ) {
      throw new Error("invalid session row");
    }
    row = full;
  } else {
    const previous = transaction.get(identity);
    const set = asNullableRecord(wire.set);
    if (
      !validVersion(wire.base) ||
      wire.version <= wire.base ||
      !previous ||
      previous.version !== wire.base ||
      !set ||
      !Array.isArray(wire.remove) ||
      wire.remove.some(
        (field) =>
          typeof field !== "string" ||
          field === "key" ||
          field === "agentId" ||
          Object.hasOwn(set, field),
      ) ||
      (Object.hasOwn(set, "key") && set.key !== wire.key) ||
      (Object.hasOwn(set, "agentId") && set.agentId !== wire.agentId) ||
      "retain" in wire
    ) {
      throw new Error("invalid session row");
    }
    row = { ...previous.row, ...set };
    for (const field of wire.remove) {
      delete row[field];
    }
  }
  transaction.set(identity, wire.retain === false ? undefined : { version: wire.version, row });
  return row;
}

/** Connection-owned row baselines; consumers see only reconstructed legacy payloads. */
export class GatewaySessionRowEvents {
  private readonly rows = new Map<string, RetainedRow>();

  clear(): void {
    this.rows.clear();
  }

  project<T extends SessionRowEvent>(event: T): { event: T; missingBaseline: boolean } {
    if (event.event !== "sessions.changed" && event.event !== "session.message") {
      return { event, missingBaseline: false };
    }
    const payload = asNullableRecord(event.payload);
    if (!payload) {
      return { event, missingBaseline: false };
    }
    const transaction = new RowTransaction(this.rows);
    try {
      const session = decodeRow(payload.session, transaction);
      const ancestors = payload.ancestorSessions;
      const ancestorSessions = Array.isArray(ancestors)
        ? ancestors.map((row) => decodeRow(row, transaction))
        : ancestors;
      let envelope = payload;
      if (Array.isArray(ancestorSessions) && Array.isArray(payload.ancestorSessionRefs)) {
        const unresolved: unknown[] = [];
        for (const value of payload.ancestorSessionRefs) {
          const reference = asNullableRecord(value);
          const retained =
            reference &&
            typeof reference.key === "string" &&
            (reference.agentId === undefined || typeof reference.agentId === "string")
              ? transaction.get(sessionRowIdentity(reference.key, reference.agentId))?.row
              : undefined;
          if (
            !reference ||
            !retained ||
            (reference.sessionId !== undefined && typeof reference.sessionId !== "string") ||
            reference.sessionId !== retained.sessionId ||
            typeof reference.revision !== "string" ||
            reference.revision !== retained.ancestorRevision ||
            typeof reference.snapshotAt !== "number" ||
            !Number.isFinite(reference.snapshotAt)
          ) {
            unresolved.push(value);
            continue;
          }
          // References certify content, but never change the wire delta baseline or its LRU.
          ancestorSessions.push({ ...retained, snapshotAt: reference.snapshotAt });
        }
        if (unresolved.length !== payload.ancestorSessionRefs.length) {
          envelope = { ...payload };
          if (unresolved.length) {
            envelope.ancestorSessionRefs = unresolved;
          } else {
            delete envelope.ancestorSessionRefs;
          }
        }
      }
      if (Object.hasOwn(payload, "sessionFieldRefs")) {
        const row = asNullableRecord(session);
        if (!row || !Array.isArray(payload.sessionFieldRefs)) {
          throw new Error("invalid session row");
        }
        const fields = Object.keys(row).toSorted();
        const restored: Record<string, unknown> = Object.create(null);
        for (const index of payload.sessionFieldRefs) {
          const field = fields[index];
          if (!Number.isInteger(index) || field === undefined || Object.hasOwn(payload, field)) {
            throw new Error("invalid session row");
          }
          restored[field] = row[field];
        }
        envelope = { ...envelope, ...restored };
        delete envelope.sessionFieldRefs;
      }
      transaction.commit();
      return {
        event:
          session === payload.session && ancestorSessions === ancestors && envelope === payload
            ? event
            : {
                ...event,
                payload: {
                  ...envelope,
                  ...(Object.hasOwn(payload, "session") ? { session } : {}),
                  ...(Object.hasOwn(payload, "ancestorSessions") ? { ancestorSessions } : {}),
                },
              },
        missingBaseline: false,
      };
    } catch {
      return { event, missingBaseline: true };
    }
  }
}
