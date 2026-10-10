import {
  sameBootRecordOwner,
  subscribeBootRecordChanges,
  type BootRecord,
} from "../../app/boot-record.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { SidebarSnapshotModel } from "../../components/sidebar-snapshot-model.ts";
import {
  sidebarSnapshotInvalidationMatches,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";
import { sidebarSnapshotScopeKey, type SidebarSnapshotScope } from "./sidebar-snapshot-scope.ts";

type PrewarmedSidebarSnapshot = {
  scope: SidebarSnapshotScope;
  revision: number;
  isCurrent: () => boolean;
  promise: Promise<SidebarSnapshotModel | null>;
  stop: () => void;
};
const pending = new WeakMap<ApplicationGateway, PrewarmedSidebarSnapshot>();

export function subscribeSidebarBootRetirement(
  currentScope: () => SidebarSnapshotScope | null,
  retire: () => void,
): () => void {
  return subscribeBootRecordChanges(({ scope, retiredOwner, replacement }) => {
    const current = currentScope();
    if (!current || (scope !== undefined && scope !== current.gatewayScope)) {
      return;
    }
    const owner = { recoveryScope: current.recoveryScope };
    if (
      (retiredOwner && !sameBootRecordOwner(retiredOwner, owner)) ||
      sameBootRecordOwner(replacement, owner)
    ) {
      return;
    }
    retire();
  });
}

/** The bootstrap owner has already admitted this record against current credentials. */
export function prewarmSidebarSnapshot(
  gateway: ApplicationGateway,
  record: Pick<BootRecord, "scope" | "recoveryScope" | "profileId">,
): () => void {
  pending.get(gateway)?.stop();
  if (!record.recoveryScope) {
    return () => {};
  }
  const scope = {
    gatewayScope: record.scope,
    recoveryScope: record.recoveryScope,
    profileId: record.profileId,
  };
  const key = sidebarSnapshotScopeKey(scope)!;
  let cancelled = false;
  const unsubscribe = subscribeSnapshotInvalidation((invalidation) => {
    if (sidebarSnapshotInvalidationMatches(key, invalidation)) {
      cancelled = true;
    }
  });
  const stopBootRetirement = subscribeSidebarBootRetirement(
    () => scope,
    () => {
      cancelled = true;
    },
  );
  const entry: PrewarmedSidebarSnapshot = {
    scope,
    revision: gateway.connectionRevision,
    isCurrent: () =>
      !cancelled &&
      !gateway.snapshot.client?.offlineRecoveryRetired &&
      gateway.connectionRevision === entry.revision,
    promise: Promise.all([
      import("./sidebar-snapshot-store.ts"),
      import("../../components/sidebar-snapshot-model.ts"),
    ])
      .then(async ([{ SidebarSnapshotStore }, { parseSidebarSnapshot }]) => {
        if (cancelled) {
          return null;
        }
        const store = new SidebarSnapshotStore(parseSidebarSnapshot);
        try {
          const model = await store.read(scope);
          return entry.isCurrent() ? model : null;
        } finally {
          store.dispose();
        }
      })
      .catch(() => null),
    stop: () => {
      cancelled = true;
      unsubscribe();
      stopBootRetirement();
      if (pending.get(gateway) === entry) {
        pending.delete(gateway);
      }
    },
  };
  pending.set(gateway, entry);
  return entry.stop;
}

export function consumePrewarmedSidebarSnapshot(
  gateway: ApplicationGateway,
): PrewarmedSidebarSnapshot | undefined {
  const entry = pending.get(gateway);
  pending.delete(gateway);
  return entry;
}
