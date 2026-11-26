import {
  sameBootRecordOwner,
  subscribeBootRecordChanges,
  type BootRecord,
} from "../../app/boot-record.ts";
import type { SidebarSnapshotModel } from "../../components/sidebar-snapshot-data.ts";
import {
  sidebarSnapshotInvalidationMatches,
  sidebarSnapshotDeletedSessionKey,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

subscribeSnapshotInvalidation((invalidation) => {
  for (const [gateway, entry] of sidebarScopes) {
    const key = sidebarSnapshotScopeKey(entry.scope);
    const deleted = sidebarSnapshotDeletedSessionKey(key, invalidation);
    if (deleted) {
      entry.snapshot = entry.snapshot.then(async (model) => {
        const { removeSidebarSnapshotSession } =
          await import("../../components/sidebar-snapshot-data.ts");
        return model && removeSidebarSnapshotSession(model, deleted);
      });
    } else if (sidebarSnapshotInvalidationMatches(key, invalidation)) {
      sidebarScopes.delete(gateway);
    }
  }
});

export type SidebarSnapshotScope = {
  gatewayScope: string;
  recoveryScope: string;
  profileId: string | null;
};
export const sidebarSnapshotScopeKey = (scope: SidebarSnapshotScope): string =>
  `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000sidebar:${JSON.stringify(scope.profileId)}`;
const sidebarScopes = new Map<
  object,
  {
    scope: SidebarSnapshotScope;
    revision: number | undefined;
    snapshot: Promise<SidebarSnapshotModel | null>;
    claimed: boolean;
  }
>();

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
      (!retiredOwner || sameBootRecordOwner(retiredOwner, owner)) &&
      !sameBootRecordOwner(replacement, owner)
    ) {
      retire();
    }
  });
}

/** Bootstrap admits the account; the mounted sidebar reads before its first paint. */
export function admitSidebarBootScope(
  gateway: { readonly connectionRevision?: number },
  record: Pick<BootRecord, "scope" | "recoveryScope" | "profileId">,
): () => void {
  if (!record.recoveryScope) {
    return () => {};
  }
  const scope = {
    gatewayScope: record.scope,
    recoveryScope: record.recoveryScope,
    profileId: record.profileId,
  };
  const entry = {
    scope,
    revision: gateway.connectionRevision,
    snapshot: Promise.resolve<SidebarSnapshotModel | null>(null),
    claimed: false,
  };
  sidebarScopes.set(gateway, entry);
  entry.snapshot = Promise.all([
    import("./session-snapshot-store.ts"),
    import("../../components/sidebar-snapshot-data.ts"),
  ])
    .then(async ([{ SessionSnapshotStore }, { parseSidebarSnapshot }]) => {
      const store = new SessionSnapshotStore();
      store.connect();
      try {
        const snapshot = await store.readSidebar(
          sidebarSnapshotScopeKey(scope),
          parseSidebarSnapshot,
        );
        return sidebarScopes.get(gateway) === entry && gateway.connectionRevision === entry.revision
          ? snapshot
          : null;
      } finally {
        store.disconnect();
      }
    })
    .catch(() => null);
  const stop = subscribeSidebarBootRetirement(
    () => scope,
    () => sidebarScopes.delete(gateway),
  );
  return () => {
    stop();
    sidebarScopes.delete(gateway);
  };
}

export function readSidebarBootSnapshot(gateway: object): Promise<SidebarSnapshotModel | null> {
  return sidebarScopes.get(gateway)?.snapshot ?? Promise.resolve(null);
}

export function consumeSidebarBootScope(gateway: object) {
  const entry = sidebarScopes.get(gateway);
  if (!entry || entry.claimed) {
    return undefined;
  }
  entry.claimed = true;
  return entry;
}
