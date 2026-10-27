import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { serializedJsonArrayBytes } from "./serialized-json.js";
import type { SessionEntrySelection, SessionListFilteredEntries } from "./session-list-filters.js";
import { captureSessionRowGeneration, type SessionRowGeneration } from "./session-row-identity.js";
import { sessionRowEncodingBytes } from "./session-row-serialization.js";
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
