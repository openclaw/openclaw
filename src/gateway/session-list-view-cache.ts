import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SessionEntrySelection, SessionListFilteredEntries } from "./session-list-filters.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

// Selection and presentation have separate keys: 512 slots cover 256 complete queries.
const MAX_VIEWS = 512;
const MAX_ESTIMATED_BYTES = 32 * 1024 * 1024;
const SIDEBAR_ROW_HISTORY_LIMIT = 32;
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
  rows?: GatewaySessionRow[];
  rowHistory?: GatewaySessionRow[][];
  sidebar?: boolean;
  selection?: SessionEntrySelection;
  selectedAt?: number;
  activityExpiresAt?: number;
  partitions?: SelectionPartitions;
};

function hasSidebarBaseline(view: SessionListView): boolean {
  return view.sidebar === true && (view.rows !== undefined || Boolean(view.rowHistory?.length));
}

/** The publication owns admission, recency, accounting and retirement of every list view. */
export class SessionListViewCache {
  private readonly lists = new Map<string, SessionListView>();
  private bytes = 0;
  private refs = 0;

  values() {
    return this.lists.values();
  }

  hasSidebarBaselines() {
    for (const view of this.lists.values()) {
      if (hasSidebarBaseline(view)) {
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
    if (view.rows?.[0]?.rowMode === "sidebar") {
      this.retainRows(view, view.rows);
    }
    view.rows = undefined;
    this.update(view);
  }

  setRows(view: SessionListView, rows: GatewaySessionRow[], sidebar: boolean) {
    if (sidebar && view.rows) {
      this.retainRows(view, view.rows);
    }
    view.rows = rows;
    view.sidebar = sidebar;
    this.update(view);
  }

  private retainRows(view: SessionListView, rows: GatewaySessionRow[]) {
    const history = (view.rowHistory ??= []);
    history.push(rows);
    view.historyRefs += rows.length;
    if (history.length > SIDEBAR_ROW_HISTORY_LIMIT) {
      view.historyRefs -= history.shift()!.length;
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
    // Eight-byte row references; conservative 48-byte selection entries/tuples;
    // fixed view/array/map overhead and UTF-16 query keys. Shared row objects and
    // encodings belong to the publication, not a per-view deep-size estimate.
    const bytes =
      1024 +
      view.key.length * 2 +
      rowRefs * 8 +
      entryRefs * 48 +
      (view.partitions?.count ?? 0) * 64 +
      (view.rowHistory?.length ?? 0) * 32;
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
    if (hasSidebarBaseline(view)) {
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
    scheduleRetentionReport();
  }
}
