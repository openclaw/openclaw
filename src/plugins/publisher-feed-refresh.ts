import type { TrustedFeedSigningKey } from "./official-external-plugin-catalog-envelope.js";
import type {
  PublisherFeedStateStore,
  StoredPublisherFeedState,
} from "./publisher-feed-state-store.js";
import {
  applyPublisherFeedChanges,
  fetchPublisherFeedChanges,
  fetchPublisherFeedSnapshot,
  PublisherFeedChangeTraversalLimitError,
  type PublisherFeedSnapshotResult,
} from "./publisher-feed-transport.js";

export type PublisherFeedRefreshTarget = {
  baseUrl: string;
  publisherId: string;
  verification: {
    trustedKeys: readonly TrustedFeedSigningKey[];
    threshold?: number;
  };
};

type PublisherFeedRefreshDependencies = {
  fetchSnapshot?: typeof fetchPublisherFeedSnapshot;
  fetchChanges?: typeof fetchPublisherFeedChanges;
};

export type PublisherFeedRefreshResult = {
  status: "initialized" | "updated" | "unchanged" | "reset";
  record: StoredPublisherFeedState;
};

function samePublisherFeedState(
  left: StoredPublisherFeedState["state"],
  right: StoredPublisherFeedState["state"],
): boolean {
  return (
    left.feedId === right.feedId &&
    left.sequence === right.sequence &&
    left.generatedAt === right.generatedAt &&
    left.publisherId === right.publisherId &&
    left.handle === right.handle &&
    left.displayName === right.displayName &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries)
  );
}

function sourceOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("publisher feed refresh source must be an HTTPS origin");
  }
  return url.origin;
}

function publisherId(raw: string): string {
  const normalized = raw.trim();
  if (!normalized || new TextEncoder().encode(normalized).length > 200) {
    throw new Error("publisher feed refresh publisher id is invalid");
  }
  return normalized;
}

function snapshotRecord(params: {
  origin: string;
  snapshot: PublisherFeedSnapshotResult;
  verifiedAt: string;
}): StoredPublisherFeedState {
  return {
    sourceOrigin: params.origin,
    state: params.snapshot.state,
    verification: params.snapshot.verification,
    verifiedAt: params.verifiedAt,
  };
}

export async function refreshPublisherFeedState(
  params: PublisherFeedRefreshTarget & {
    store: PublisherFeedStateStore;
    forceSnapshot?: boolean;
    now?: () => Date;
    dependencies?: PublisherFeedRefreshDependencies;
  },
): Promise<PublisherFeedRefreshResult> {
  const origin = sourceOrigin(params.baseUrl);
  const normalizedPublisherId = publisherId(params.publisherId);
  const now = params.now ?? (() => new Date());
  const fetchSnapshot = params.dependencies?.fetchSnapshot ?? fetchPublisherFeedSnapshot;
  const fetchChanges = params.dependencies?.fetchChanges ?? fetchPublisherFeedChanges;
  const current = await params.store.read(origin, normalizedPublisherId);
  const transport = {
    baseUrl: origin,
    publisherId: normalizedPublisherId,
    verification: params.verification,
    now,
  };
  if (!current || params.forceSnapshot) {
    const snapshot = await fetchSnapshot(transport);
    const record = snapshotRecord({ origin, snapshot, verifiedAt: now().toISOString() });
    if (current && record.state.sequence < current.state.sequence) {
      throw new Error("publisher feed snapshot is older than accepted state");
    }
    if (
      current &&
      record.state.sequence === current.state.sequence &&
      !samePublisherFeedState(record.state, current.state)
    ) {
      throw new Error("publisher feed snapshot changed without a sequence increment");
    }
    await params.store.write(record);
    return {
      status: current
        ? record.state.sequence === current.state.sequence
          ? "unchanged"
          : "updated"
        : "initialized",
      record,
    };
  }

  let changes: Awaited<ReturnType<typeof fetchPublisherFeedChanges>>;
  try {
    changes = await fetchChanges({ ...transport, fromSequence: current.state.sequence });
  } catch (error) {
    if (!(error instanceof PublisherFeedChangeTraversalLimitError)) {
      throw error;
    }
    const snapshot = await fetchSnapshot(transport);
    const record = snapshotRecord({ origin, snapshot, verifiedAt: now().toISOString() });
    if (record.state.sequence < current.state.sequence) {
      throw new Error("publisher feed recovery snapshot is older than accepted state", {
        cause: error,
      });
    }
    if (
      record.state.sequence === current.state.sequence &&
      !samePublisherFeedState(record.state, current.state)
    ) {
      throw new Error("publisher feed recovery snapshot changed without a sequence increment", {
        cause: error,
      });
    }
    await params.store.write(record);
    return {
      status: record.state.sequence === current.state.sequence ? "unchanged" : "reset",
      record,
    };
  }
  if (changes.status === "reset-required") {
    const snapshot = await fetchSnapshot(transport);
    if (
      snapshot.state.feedId !== changes.reset.feedId ||
      snapshot.state.sequence !== changes.reset.currentSequence ||
      snapshot.state.sequence <= current.state.sequence
    ) {
      throw new Error("publisher feed reset snapshot does not match the signed reset instruction");
    }
    const record = snapshotRecord({ origin, snapshot, verifiedAt: now().toISOString() });
    await params.store.write(record);
    return { status: "reset", record };
  }

  const applied = applyPublisherFeedChanges(current.state, changes);
  if (applied.status !== "applied") {
    throw new Error("publisher feed change application unexpectedly requested reset");
  }
  const record: StoredPublisherFeedState = {
    sourceOrigin: origin,
    state: applied.state,
    verification: changes.verification,
    verifiedAt: now().toISOString(),
  };
  await params.store.write(record);
  return {
    status: applied.state.sequence === current.state.sequence ? "unchanged" : "updated",
    record,
  };
}
