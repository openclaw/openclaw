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

function selectionRefs(value: SessionEntrySelection | SessionListFilteredEntries) {
  return (
    value.entries.length +
    ("ownerEntries" in value ? value.ownerEntries.length : 0) +
    value.ownerFacet.length +
    (value.ownerSessionCounts?.length ?? 0) +
    (value.ownerSessionProfiles?.size ?? 0) +
    (value.people?.length ?? 0)
  );
}

class SelectionPartitions extends WeakMap<object, SessionListFilteredEntries> {
  refs = 0;
  count = 0;

  override set(key: object, value: SessionListFilteredEntries) {
    const previous = this.get(key);
    this.refs += selectionRefs(value) - (previous ? selectionRefs(previous) : 0);
    this.count += Number(!previous);
    // Dead weak keys may overestimate retention until view eviction. Never undercount
    // old partition arrays by scanning or trying to predict garbage collection.
    return super.set(key, value);
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
    const refs = rowRefs + entryRefs;
    // Eight-byte current row references/history IDs; conservative selection entries,
    // vector/revision overhead and UTF-16 query keys. Duplicate current row strings
    // are discounted separately while any view retains them.
    const bytes =
      1024 +
      view.key.length * 2 +
      rowRefs * 8 +
      entryRefs * 48 +
      (view.partitions?.count ?? 0) * 64 +
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
  type Fact = { encoded: string; fact: Partial<T>; rows: number | number[] };
  const prepared = new WeakMap<
    T,
    {
      facts: Fact[];
      bytes: number;
      rawBytes: number;
      packed?: { row: GatewaySessionRow; keys: string[] };
    }
  >();
  const share = (sessions: T[]) => {
    // Empty and single-row deltas cannot share facts; keep their prepared wire rows.
    if (sessions.length < 2) {
      return { sessions, sharedFacts: [] };
    }
    type SharedFact = { fact: Partial<T>; rows: number[] };
    const candidates = new Map<string, Fact>();
    const rows: GatewaySessionRow[] = [];
    sessions.forEach((row, index) => {
      const { key, kind, updatedAt, sessionId, rowMode } = row;
      const required = { key, kind, updatedAt, sessionId, rowMode };
      rows.push(required);
      let facts = prepared.get(row)?.facts;
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
        const rawBytes = JSON.stringify(required).length * 2 + bytes - facts.length * 2;
        prepared.set(row, { facts, bytes, rawBytes });
      }
      for (const fact of facts) {
        const candidate = candidates.get(fact.encoded);
        if (candidate) {
          if (typeof candidate.rows === "number") {
            candidate.rows = [candidate.rows, index];
          } else {
            candidate.rows.push(index);
          }
        } else {
          fact.rows = index;
          candidates.set(fact.encoded, fact);
        }
      }
    });
    // Facts with the same recipients share one reference, including common scalar defaults.
    const groups = new Map<string, SharedFact>();
    for (const candidate of candidates.values()) {
      const recipients = candidate.rows;
      // Recipient scratch belongs to this response, never to the retained row facts.
      candidate.rows = 0;
      if (typeof recipients === "number") {
        Object.assign(rows[recipients]!, candidate.fact);
        continue;
      }
      const key = recipients.join(",");
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
      for (const index of group.rows) {
        (rows[index]!.sharedFacts ??= []).push(reference);
      }
    }
    for (let index = 0; index < rows.length; index++) {
      const retained = prepared.get(sessions[index]!)!;
      const row = rows[index]!;
      const previous = retained.packed;
      let keyCount = 0;
      for (const key in row) {
        if (key !== previous?.keys[keyCount++]) {
          keyCount = -1;
          break;
        }
      }
      // The immutable source owns values; only field order and response-local fact indexes
      // can change its packed bytes. Retain one layout, never a cache of list shapes.
      const sameKeys = previous && previous.keys.length === keyCount;
      if (
        sameKeys &&
        previous.row.sharedFacts?.length === row.sharedFacts?.length &&
        (row.sharedFacts?.every((ref, position) => ref === previous.row.sharedFacts?.[position]) ??
          true)
      ) {
        rows[index] = previous.row;
      } else {
        if (sameKeys && row.sharedFacts) {
          // Packing appends numeric fact indexes last. All preceding fields and their
          // order still belong to the same immutable source; only replace that array.
          const encoded = serializeSessionRow(previous.row);
          registerSerializedSessionRow(
            row,
            encoded.slice(0, encoded.lastIndexOf("[")) + JSON.stringify(row.sharedFacts) + "}",
          );
        }
        retained.packed = { row, keys: sameKeys ? previous.keys : Object.keys(row) };
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
            (retained.packed ? sessionRowEncodingBytes(retained.packed.row) : 0)
        : 0;
    },
  };
}

export const { share: shareSessionRowFacts, encodingBytes: sessionRowFactEncodingBytes } =
  createSessionRowFactSharing<GatewaySessionRow>();
