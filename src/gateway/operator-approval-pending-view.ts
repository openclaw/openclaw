import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isStateDatabaseReadAdmissionInvalidatedError,
} from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { matchesOperatorApprovalReviewerBinding } from "./operator-approval-reviewer-binding.js";
import { operatorApprovalPublication } from "./operator-approval-store.publication.js";
import {
  decodeOperatorApprovalRow,
  OPERATOR_APPROVAL_MAX_LIST_LIMIT,
  requireString,
} from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalKind,
  OperatorApprovalRecord,
} from "./operator-approval-store.types.js";

export type PendingApprovalPage = {
  records: OperatorApprovalRecord[];
  corrupt: { createdAtMs: number; id: string }[];
  cursor?: string;
};
type PendingApprovalSelection = {
  kind?: OperatorApprovalKind;
  sourceSessionKey?: string;
  audienceSessionKey?: string;
  reviewerDeviceId?: string;
  limit?: number;
  nowMs: number;
};
type Bucket = {
  rows: Map<string, OperatorApprovalRecord>;
  revision: number;
  ordered?: OperatorApprovalRecord[];
};
type Entry = {
  path: string;
  view?: PendingApprovalIndex;
};

function createBucket(): Bucket {
  return { rows: new Map(), revision: 0 };
}

function order(bucket: Bucket): OperatorApprovalRecord[] {
  return (bucket.ordered ??= [...bucket.rows.values()].toSorted(
    (left, right) =>
      left.createdAtMs - right.createdAtMs ||
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
  ));
}

class PendingApprovalIndex {
  private readonly all = createBucket();
  private readonly sessions = new Map<string, Bucket>();
  private readonly expiries = new Map<number, number>();
  private readonly corrupt = new Set<string>();
  private nextExpiry = Infinity;

  constructor(private readonly current: () => boolean) {}

  dispose() {
    for (const bucket of [this.all, ...this.sessions.values()]) {
      bucket.rows.clear();
      bucket.ordered = undefined;
    }
    this.sessions.clear();
    this.expiries.clear();
    this.corrupt.clear();
  }

  private updateBucket(bucket: Bucket, id: string, record?: OperatorApprovalRecord) {
    if (record) {
      bucket.rows.set(id, record);
    } else {
      bucket.rows.delete(id);
    }
    bucket.revision++;
    bucket.ordered = undefined;
  }

  replace(id: string, record?: OperatorApprovalRecord, corrupt = false) {
    const previous = this.all.rows.get(id);
    if (previous) {
      this.updateBucket(this.all, id);
      for (const key of new Set(previous.audienceSessionKeys)) {
        const bucket = this.sessions.get(key)!;
        this.updateBucket(bucket, id);
        if (!bucket.rows.size) {
          this.sessions.delete(key);
        }
      }
      const count = this.expiries.get(previous.expiresAtMs)! - 1;
      if (count) {
        this.expiries.set(previous.expiresAtMs, count);
      } else {
        this.expiries.delete(previous.expiresAtMs);
      }
    }
    this.corrupt.delete(id);
    if (corrupt) {
      this.corrupt.add(id);
    }
    if (!record) {
      return;
    }
    this.updateBucket(this.all, id, record);
    for (const key of new Set(record.audienceSessionKeys)) {
      let bucket = this.sessions.get(key);
      if (!bucket) {
        bucket = createBucket();
        this.sessions.set(key, bucket);
      }
      this.updateBucket(bucket, id, record);
    }
    this.expiries.set(record.expiresAtMs, (this.expiries.get(record.expiresAtMs) ?? 0) + 1);
    this.nextExpiry = Math.min(this.nextExpiry, record.expiresAtMs);
  }

  finishPublication() {
    if (!this.expiries.has(this.nextExpiry)) {
      this.nextExpiry = Infinity;
      for (const expiry of this.expiries.keys()) {
        this.nextExpiry = Math.min(this.nextExpiry, expiry);
      }
    }
  }

  select(params: PendingApprovalSelection, replay: boolean) {
    if (!this.current() || this.corrupt.size || (replay && this.nextExpiry <= params.nowMs)) {
      return undefined;
    }
    const { kind, sourceSessionKey, reviewerDeviceId, nowMs } = params;
    const sessionKey =
      params.audienceSessionKey === undefined
        ? undefined
        : requireString(params.audienceSessionKey, "operator approval audience session key");
    const limit = Math.max(1, Math.min(params.limit ?? 1_000, OPERATOR_APPROVAL_MAX_LIST_LIMIT));
    const bucketForSelection = () =>
      sessionKey === undefined ? this.all : this.sessions.get(sessionKey);
    const select = (bucket: Bucket | undefined) => {
      const records: OperatorApprovalRecord[] = [];
      if (bucket) {
        for (const record of order(bucket)) {
          if (
            record.expiresAtMs > nowMs &&
            (!kind || record.kind === kind) &&
            (!sourceSessionKey || record.source.sessionKey === sourceSessionKey) &&
            (reviewerDeviceId === undefined ||
              matchesOperatorApprovalReviewerBinding(record, reviewerDeviceId))
          ) {
            records.push(record);
            if (records.length === limit) {
              break;
            }
          }
        }
      }
      return records;
    };
    let bucket = bucketForSelection();
    let revision = bucket?.revision;
    const records = select(bucket);
    const selectedExpiry = records.reduce(
      (expiry, record) => Math.min(expiry, record.expiresAtMs),
      Infinity,
    );
    return {
      records,
      isCurrent: () => {
        if (
          !this.current() ||
          this.corrupt.size ||
          Date.now() >= (replay ? this.nextExpiry : selectedExpiry)
        ) {
          return false;
        }
        const nextBucket = bucketForSelection();
        if (nextBucket !== bucket || nextBucket?.revision !== revision) {
          const next = select(nextBucket);
          if (
            next.length !== records.length ||
            next.some((record, index) => record !== records[index])
          ) {
            return false;
          }
          bucket = nextBucket;
          revision = nextBucket?.revision;
        }
        return true;
      },
    };
  }
}

export type PendingApprovalView = Pick<PendingApprovalIndex, "select">;

function dropView(entries: Map<string, Entry>, identity: string) {
  entries.get(identity)?.view?.dispose();
  entries.delete(identity);
}

const views = resolveGlobalSingleton(
  Symbol.for("openclaw.operatorApprovalPendingViews"),
  () => {
    const entries = new Map<string, Entry>();
    registerOpenClawStateDatabaseAsyncResource({
      async close(closingIdentity) {
        for (const [identity, entry] of entries) {
          if (!closingIdentity || entry.path === closingIdentity.canonicalPath) {
            dropView(entries, identity);
          }
        }
      },
    });
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened") {
        for (const [identity, entry] of entries) {
          if (entry.path === (event.identity?.canonicalPath ?? event.path)) {
            dropView(entries, identity);
          }
        }
      }
    });
    operatorApprovalPublication.subscribeFacts((change) => {
      if (change.kind !== "committed" && change.kind !== "unknown") {
        return;
      }
      const identity =
        change.kind === "committed" ? change.receipt.source.identity : change.identity;
      if (typeof identity !== "string") {
        return;
      }
      const entry = entries.get(identity);
      if (!entry) {
        return;
      }
      if (change.kind === "unknown") {
        dropView(entries, identity);
        return;
      }
      for (const [id, fact] of change.receipt.facts) {
        if (fact.kind === "unchanged") {
          continue;
        }
        if (!entry.view || fact.kind === "unknown") {
          dropView(entries, identity);
          return;
        }
        const pending = fact.kind === "postimage" && fact.value.status === "pending";
        const record = pending ? decodeOperatorApprovalRow(fact.value) : undefined;
        entry.view.replace(id, record ?? undefined, pending && !record);
      }
      entry.view?.finishPublication();
    });
    return entries;
  },
  (entries) => {
    for (const identity of entries.keys()) {
      dropView(entries, identity);
    }
  },
  "close-and-restart",
);

/** Called while the approval-store FIFO owns the read and any required repair. */
export async function prepareOperatorApprovalPendingView(
  context: OpenClawStateWorkerContext,
  loadPage: (cursor?: string) => Promise<PendingApprovalPage>,
): Promise<PendingApprovalView | undefined> {
  const options = { path: context.admission.databasePath, env: context.environment };
  if (
    isArtifactPreservingStateRead() ||
    getOpenClawDatabaseMaintenanceScope() ||
    getActiveOpenClawStateDatabaseReadSnapshot(options)
  ) {
    return undefined;
  }
  const identity = context.admission.identity.key;
  let entry = views.get(identity);
  if (!entry) {
    entry = { path: context.admission.identity.canonicalPath };
    views.set(identity, entry);
    if (views.size > 64) {
      dropView(views, views.keys().next().value!);
    }
  }
  const retained = entry;
  if (!retained.view) {
    const assertOwnerCurrent = context.assertPublicationCurrent ?? context.admission.assertCurrent;
    const view = new PendingApprovalIndex(() => {
      if (views.get(identity) !== retained) {
        return false;
      }
      try {
        assertOwnerCurrent();
        return true;
      } catch (error) {
        if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
          throw error;
        }
        dropView(views, identity);
        return false;
      }
    });
    try {
      let cursor: string | undefined;
      do {
        const page = await loadPage(cursor);
        context.admission.assertCurrent();
        if (views.get(identity) !== retained || context.admission.identity.key !== identity) {
          if (views.get(identity) === retained) {
            dropView(views, identity);
          }
          return undefined;
        }
        for (const record of page.records) {
          view.replace(record.id, record);
        }
        for (const row of page.corrupt) {
          view.replace(row.id, undefined, true);
        }
        cursor = page.cursor;
      } while (cursor);
      retained.view = view;
    } catch (error) {
      if (views.get(identity) === retained) {
        dropView(views, identity);
      }
      throw error;
    }
  }
  context.admission.assertCurrent();
  return views.get(identity) === retained ? retained.view : undefined;
}
