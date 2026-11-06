import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { serializedJsonArrayBytes } from "./serialized-json.js";
import type { SessionEntrySelection, SessionListFilteredEntries } from "./session-list-filters.js";
import { captureSessionRowGeneration, type SessionRowGeneration } from "./session-row-identity.js";
import {
  registerSerializedSessionRow,
  serializeSessionRow,
  sessionRowEncodingBytes,
} from "./session-row-serialization.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

// Selection and presentation have separate keys: 512 slots cover 256 complete queries.
const MAX_VIEWS = 512;
const MAX_ESTIMATED_BYTES = 32 * 1024 * 1024;
const ROW_HISTORY_LIMIT = 32;
let retainedViews = 0;
let retainedRefs = 0;
let retainedBytes = 0;
let retentionReportPending = false;

function scheduleRetentionReport() {
  if (retentionReportPending) {
    return;
  }
  retentionReportPending = true;
  setImmediate(() => {
    retentionReportPending = false;
    emitTrustedDiagnosticEvent({
      type: "sessions.list.retention",
      views: retainedViews,
      refs: retainedRefs,
      estimatedBytes: retainedBytes,
    });
  }).unref();
}

function selectionEntryRefs(value: SessionEntrySelection | SessionListFilteredEntries) {
  return value.entries.length + ("ownerEntries" in value ? value.ownerEntries.length : 0);
}

function selectionRefs(value: SessionEntrySelection | SessionListFilteredEntries) {
  return (
    selectionEntryRefs(value) +
    value.ownerFacet.length +
    (value.ownerSessionCounts?.length ?? 0) +
    (value.ownerSessionProfiles?.size ?? 0) +
    (value.people?.length ?? 0)
  );
}

class SelectionPartitions extends Map<object, SessionListFilteredEntries> {
  refs = 0;
  entryRefs = 0;

  override set(key: object, value: SessionListFilteredEntries) {
    const previous = this.get(key);
    this.refs += selectionRefs(value) - (previous ? selectionRefs(previous) : 0);
    this.entryRefs += selectionEntryRefs(value) - (previous ? selectionEntryRefs(previous) : 0);
    return super.set(key, value);
  }

  override delete(key: object) {
    const previous = this.get(key);
    if (previous) {
      this.refs -= selectionRefs(previous);
      this.entryRefs -= selectionEntryRefs(previous);
    }
    return super.delete(key);
  }
}

export function retainCurrentSessionListPartitions(
  retained: Map<object, SessionListFilteredEntries>,
  partitions: Iterable<{ revision: object; entries: { size: number } }>,
) {
  // Only current nonempty partitions can be reused. Retire obsolete values and
  // their charges together, without waiting for revision tokens to be collected.
  const revisions = new Set<object>();
  for (const partition of partitions) {
    if (partition.entries.size) {
      revisions.add(partition.revision);
    }
  }
  for (const revision of retained.keys()) {
    if (!revisions.has(revision)) {
      retained.delete(revision);
    }
  }
}

export type SessionListView = {
  key: string;
  refs: number;
  bytes: number;
  historyRefs: number;
  encodedBytes?: number;
  rows?: GatewaySessionRow[];
  rowHistory?: SessionRowGeneration[];
  conditional?: boolean;
  selection?: SessionEntrySelection;
  selectedAt?: number;
  activityExpiresAt?: number;
  partitions?: SelectionPartitions;
};

function hasRowBaseline(view: SessionListView): boolean {
  return view.conditional === true && (view.rows !== undefined || Boolean(view.rowHistory?.length));
}

/** The publication owns admission, recency, accounting and retirement of every list view. */
export class SessionListViewCache {
  private readonly lists = new Map<string, SessionListView>();
  private rowEncodings = new WeakMap<
    GatewaySessionRow,
    { refs: number; bytes: number; extraBytes: number; factBytes: number }
  >();
  private bytes = 0;
  private refs = 0;

  values() {
    return this.lists.values();
  }

  hasRowBaselines() {
    for (const view of this.lists.values()) {
      if (hasRowBaseline(view)) {
        return true;
      }
    }
    return false;
  }

  get(key: string): SessionListView {
    let view = this.lists.get(key);
    if (view) {
      this.lists.delete(key);
      this.lists.set(key, view);
      return view;
    }
    view = { key, refs: 0, bytes: 0, historyRefs: 0 };
    this.lists.set(key, view);
    retainedViews++;
    this.update(view);
    return view;
  }

  partitions(view: SessionListView) {
    return (view.partitions ??= new SelectionPartitions());
  }

  retireRows(view: SessionListView) {
    if (view.rows && this.lists.get(view.key) === view) {
      this.releaseRowEncodings(view.rows);
    }
    if (view.conditional && view.rows) {
      this.retainRows(view, view.rows);
    }
    view.rows = undefined;
    view.encodedBytes = 0;
    this.update(view);
  }

  setRows(
    view: SessionListView,
    rows: GatewaySessionRow[],
    conditional: boolean,
    sharedBytes = 0,
    extraRowEncodingBytes?: (row: GatewaySessionRow) => number,
  ) {
    const retained = this.lists.get(view.key) === view;
    if (retained && view.rows) {
      this.releaseRowEncodings(view.rows);
    }
    view.conditional ||= conditional;
    if (view.conditional && view.rows && view.rows !== rows) {
      this.retainRows(view, view.rows);
    }
    view.rows = rows;
    view.encodedBytes =
      (retained ? this.retainRowEncodings(rows, extraRowEncodingBytes) : 0) +
      serializedJsonArrayBytes(rows) +
      sharedBytes;
    this.update(view);
  }

  private retainRowEncodings(
    rows: GatewaySessionRow[],
    extraBytes?: (row: GatewaySessionRow) => number,
  ) {
    let bytes = 0;
    for (const row of rows) {
      let encoding = this.rowEncodings.get(row);
      if (encoding) {
        encoding.refs++;
        // Each view reports its full cost; the cache charges shared row strings once.
        this.bytes -= encoding.bytes;
        retainedBytes -= encoding.bytes;
      } else {
        encoding = { refs: 1, bytes: sessionRowEncodingBytes(row), extraBytes: 0, factBytes: 0 };
        this.rowEncodings.set(row, encoding);
      }
      // Keep the per-view charge fixed. Later row/fact encodings belong to the
      // shared lifetime, including after the view that prepared them retires.
      encoding.factBytes = extraBytes?.(row) ?? encoding.factBytes;
      const extra = encoding.factBytes + sessionRowEncodingBytes(row) - encoding.bytes;
      const added = extra - encoding.extraBytes;
      this.bytes += added;
      retainedBytes += added;
      encoding.extraBytes = extra;
      bytes += encoding.bytes;
    }
    return bytes;
  }

  private releaseRowEncodings(rows: GatewaySessionRow[]) {
    for (const row of rows) {
      const encoding = this.rowEncodings.get(row)!;
      if (--encoding.refs === 0) {
        this.rowEncodings.delete(row);
        this.bytes -= encoding.extraBytes;
        retainedBytes -= encoding.extraBytes;
      } else {
        this.bytes += encoding.bytes;
        retainedBytes += encoding.bytes;
      }
    }
  }

  private retainRows(view: SessionListView, rows: GatewaySessionRow[]) {
    const history = (view.rowHistory ??= []);
    history.push(captureSessionRowGeneration(rows));
    view.historyRefs += rows.length;
    if (history.length > ROW_HISTORY_LIMIT) {
      view.historyRefs -= history.shift()!.ids.length;
      emitTrustedDiagnosticEvent({
        type: "sessions.list.baseline.retired",
        cause: "history-evicted",
      });
    }
  }

  update(view: SessionListView) {
    // A single oversized response is served but not retained, including later work
    // on its ephemeral view. This also covers admission evicting the view itself.
    if (this.lists.get(view.key) !== view) {
      return;
    }
    const rowRefs = (view.rows?.length ?? 0) + view.historyRefs;
    const entryRefs =
      (view.selection ? selectionRefs(view.selection) : 0) + (view.partitions?.refs ?? 0);
    const pairRefs =
      (view.selection ? selectionEntryRefs(view.selection) : 0) + (view.partitions?.entryRefs ?? 0);
    const refs = rowRefs + entryRefs;
    // Selection vectors reference pairs owned by the selection index; charge their
    // slots, not another pair per view. Facet/map records retain the larger estimate.
    // Shared current row strings are discounted separately.
    const bytes =
      1024 +
      view.key.length * 2 +
      rowRefs * 8 +
      pairRefs * 8 +
      (entryRefs - pairRefs) * 48 +
      (view.partitions?.size ?? 0) * 64 +
      (view.rowHistory?.length ?? 0) * 160 +
      (view.encodedBytes ?? 0);
    retainedRefs += refs - view.refs;
    this.refs += refs - view.refs;
    retainedBytes += bytes - view.bytes;
    this.bytes += bytes - view.bytes;
    view.refs = refs;
    view.bytes = bytes;
    if (bytes > MAX_ESTIMATED_BYTES) {
      this.remove(view);
    }
    while (this.lists.size > MAX_VIEWS || this.bytes > MAX_ESTIMATED_BYTES) {
      const oldest = this.lists.values().next().value!;
      this.remove(oldest);
    }
    scheduleRetentionReport();
  }

  private remove(view: SessionListView) {
    if (view.rows) {
      this.releaseRowEncodings(view.rows);
    }
    if (hasRowBaseline(view)) {
      emitTrustedDiagnosticEvent({
        type: "sessions.list.baseline.retired",
        cause: "view-evicted",
      });
    }
    this.lists.delete(view.key);
    this.bytes -= view.bytes;
    retainedBytes -= view.bytes;
    retainedRefs -= view.refs;
    this.refs -= view.refs;
    retainedViews--;
    scheduleRetentionReport();
  }

  clear() {
    retainedRefs -= this.refs;
    retainedViews -= this.lists.size;
    retainedBytes -= this.bytes;
    this.bytes = 0;
    this.refs = 0;
    this.lists.clear();
    this.rowEncodings = new WeakMap();
    scheduleRetentionReport();
  }
}

/** Immutable row identities own field preparation; fact indexes stay response-local. */
function createSessionRowFactSharing<T extends GatewaySessionRow>() {
  // Negative numbers encode a leading run [0, -rows); nonnegative numbers are singletons.
  type Fact = { encoded: string; fact: Partial<T>; rows: number | number[] };
  const prepared = new WeakMap<
    T,
    {
      facts: Fact[];
      bytes: number;
      rawBytes: number;
      packed?: {
        row: GatewaySessionRow;
        fields: Fact[];
        prefix?: { json: string; utf8Bytes: number; retainedBytes: number };
      };
    }
  >();
  const share = (sessions: T[]) => {
    // Empty and single-row deltas cannot share facts; keep their prepared wire rows.
    if (sessions.length < 2) {
      return { sessions, sharedFacts: [] };
    }
    type SharedFact = { fact: Partial<T>; rows: number | number[] };
    const candidates = new Map<string, Fact>();
    const rows: GatewaySessionRow[] = [];
    const fieldCounts = new Uint32Array(sessions.length);
    const fields: Fact[][] = [];
    const referenceCounts = new Uint32Array(sessions.length);
    const required = (row: T): GatewaySessionRow => {
      const { key, kind, updatedAt, sessionId, rowMode } = row;
      return { key, kind, updatedAt, sessionId, rowMode };
    };
    const retainedRows = sessions.map((row, index) => {
      let retained = prepared.get(row);
      rows.push(retained?.packed?.row ?? required(row));
      let facts = retained?.facts;
      if (!facts) {
        facts = [];
        let bytes = 0;
        for (const field in row) {
          const value = row[field];
          // Keep required fields and the projection marker readable without expanding the table.
          if (
            value === undefined ||
            ["key", "kind", "updatedAt", "sessionId", "rowMode"].includes(field)
          ) {
            continue;
          }
          const fact: Partial<T> = {};
          fact[field] = value;
          const encoded = JSON.stringify(fact);
          facts.push({ encoded, fact, rows: 0 });
          bytes += encoded.length * 2;
        }
        // Reserve a possible singleton delta without retaining its unused raw JSON.
        // Each optional one-field object contributes its property and one comma.
        const rawBytes = JSON.stringify(rows[index]).length * 2 + bytes - facts.length * 2;
        retained = { facts, bytes, rawBytes };
        prepared.set(row, retained);
      }
      for (const fact of facts) {
        const candidate = candidates.get(fact.encoded);
        if (candidate) {
          if (typeof candidate.rows === "number") {
            if (candidate.rows === -index) {
              candidate.rows--;
            } else {
              candidate.rows =
                candidate.rows < 0
                  ? Array.from({ length: -candidate.rows }, (_, i) => i)
                  : [candidate.rows];
              candidate.rows.push(index);
            }
          } else {
            candidate.rows.push(index);
          }
        } else {
          fact.rows = index === 0 ? -1 : index;
          candidates.set(fact.encoded, fact);
        }
      }
      return retained!;
    });
    // A source can occur twice in one page; publishing one occurrence must not
    // replace the comparison layout of its later aliases.
    const previousRows = retainedRows.map((retained) => retained.packed);
    // Compare each response-local layout against the immutable source's last packed row.
    // Copy only the matching singleton prefix when that layout actually changes.
    const writable = (index: number) => {
      const previous = previousRows[index];
      let row = rows[index]!;
      if (previous && row === previous.row) {
        row = required(sessions[index]!);
        const prefix = previous.fields.slice(0, fieldCounts[index]);
        for (const field of prefix) {
          Object.assign(row, field.fact);
        }
        fields[index] = prefix;
        rows[index] = row;
      }
      return row;
    };
    // Facts with the same recipients share one reference, including common scalar defaults.
    const groups = new Map<string, SharedFact>();
    for (const candidate of candidates.values()) {
      let recipients = candidate.rows;
      // Recipient scratch belongs to this response, never to the retained row facts.
      candidate.rows = 0;
      if (typeof recipients === "number" && recipients >= -1) {
        recipients = Math.max(0, recipients);
        const previous = previousRows[recipients];
        if (
          !previous ||
          rows[recipients] !== previous.row ||
          previous.fields[fieldCounts[recipients]!] !== candidate
        ) {
          Object.assign(writable(recipients), candidate.fact);
          (fields[recipients] ??= []).push(candidate);
        }
        fieldCounts[recipients]!++;
        continue;
      }
      // Common defaults need no per-field copies of the same all-row index vector.
      if (typeof recipients === "number" && recipients !== -sessions.length) {
        recipients = Array.from({ length: -recipients }, (_, i) => i);
      }
      const key = typeof recipients === "number" ? "" : recipients.join(",");
      const group = groups.get(key);
      if (group) {
        Object.assign(group.fact, candidate.fact);
      } else {
        groups.set(key, { fact: { ...candidate.fact }, rows: recipients });
      }
    }
    const sharedFacts: Partial<T>[] = [];
    for (const group of groups.values()) {
      const reference = sharedFacts.push(group.fact) - 1;
      const count = typeof group.rows === "number" ? -group.rows : group.rows.length;
      for (let offset = 0; offset < count; offset++) {
        const index = typeof group.rows === "number" ? offset : group.rows[offset]!;
        const position = referenceCounts[index]!++;
        const previous = previousRows[index];
        if (
          previous &&
          rows[index] === previous.row &&
          previous.row.sharedFacts?.[position] === reference
        ) {
          continue;
        }
        const row = writable(index);
        (row.sharedFacts ??= previous?.row.sharedFacts?.slice(0, position) ?? []).push(reference);
      }
    }
    for (let index = 0; index < rows.length; index++) {
      const retained = retainedRows[index]!;
      const previous = previousRows[index];
      const references = referenceCounts[index]!;
      if (
        previous &&
        rows[index] === previous.row &&
        (previous.fields.length !== fieldCounts[index] ||
          (previous.row.sharedFacts?.length ?? 0) !== references)
      ) {
        const row = writable(index);
        if (references > 0) {
          row.sharedFacts = previous.row.sharedFacts!.slice(0, references);
        }
      }
      const row = rows[index]!;
      if (row !== previous?.row) {
        const currentFields = fields[index] ?? [];
        const sameKeys =
          previous &&
          currentFields.length === previous.fields.length &&
          currentFields.every((field, i) => field === previous.fields[i]) &&
          Boolean(row.sharedFacts) === Boolean(previous.row.sharedFacts);
        let prefix: NonNullable<typeof previous>["prefix"];
        if (sameKeys && row.sharedFacts) {
          // Packing appends numeric fact indexes last. All preceding fields and their
          // order still belong to the same immutable source; only replace that array.
          if (previous.prefix === undefined) {
            const encoded = serializeSessionRow(previous.row);
            const json = encoded.slice(0, encoded.lastIndexOf("["));
            previous.prefix = {
              json,
              utf8Bytes: Buffer.byteLength(json),
              retainedBytes: encoded.length * 2,
            };
          }
          prefix = previous.prefix;
          const suffix = JSON.stringify(row.sharedFacts) + "}";
          registerSerializedSessionRow(row, prefix.json + suffix, prefix.utf8Bytes + suffix.length);
        }
        retained.packed = { row, fields: sameKeys ? previous.fields : currentFields, prefix };
      }
    }
    return { sessions: rows, sharedFacts };
  };
  return {
    share,
    encodingBytes: (row: T) => {
      const retained = prepared.get(row);
      return retained
        ? retained.bytes +
            Math.max(0, retained.rawBytes - sessionRowEncodingBytes(row)) +
            (retained.packed
              ? sessionRowEncodingBytes(retained.packed.row) +
                (retained.packed.prefix?.retainedBytes ?? 0)
              : 0)
        : 0;
    },
  };
}

export const { share: shareSessionRowFacts, encodingBytes: sessionRowFactEncodingBytes } =
  createSessionRowFactSharing<GatewaySessionRow>();
