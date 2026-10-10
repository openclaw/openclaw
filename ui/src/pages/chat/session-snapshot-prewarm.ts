import {
  sameBootRecordOwner,
  subscribeBootRecordChanges,
  type BootRecord,
} from "../../app/boot-record.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import {
  sidebarSnapshotInvalidationMatches,
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

type PrewarmedSnapshot = {
  cacheKey: string;
  cancelled: boolean;
  promise: Promise<unknown>;
  readyAt?: number;
};

let pending: PrewarmedSnapshot | undefined;

export function discardPrewarmedChatSnapshot(cacheKey?: string): void {
  if (pending && (cacheKey === undefined || pending.cacheKey === cacheKey)) {
    pending.cancelled = true;
    pending = undefined;
  }
}

export function prewarmChatSnapshot(cacheKey: string): void {
  discardPrewarmedChatSnapshot();
  const generation = snapshotStoreGeneration;
  const entry: PrewarmedSnapshot = {
    cacheKey,
    cancelled: false,
    promise: import("./session-snapshot-database.ts")
      .then(({ readStoredChatSnapshotRecord }) => readStoredChatSnapshotRecord(cacheKey))
      .then((record) =>
        entry.cancelled || generation !== snapshotStoreGeneration ? undefined : record,
      )
      .catch(() => undefined),
  };
  pending = entry;
}

export function consumePrewarmedChatSnapshot(
  cacheKey: string,
): Pick<PrewarmedSnapshot, "promise" | "readyAt"> | undefined {
  if (pending?.cacheKey !== cacheKey) {
    return undefined;
  }
  const prewarm = pending;
  pending = undefined;
  return prewarm;
}

export function markPrewarmedChatSnapshotReady(): void {
  if (pending) {
    pending.readyAt ??= Date.now();
  }
}
subscribeSnapshotInvalidation((invalidation) => {
  const { sessionKey, scopePrefix } = invalidation;
  if (!scopePrefix || pending?.cacheKey.startsWith(scopePrefix)) {
    discardPrewarmedChatSnapshot(sessionKey);
  }
  for (const [gateway, { scope }] of sidebarScopes) {
    if (sidebarSnapshotInvalidationMatches(sidebarSnapshotScopeKey(scope), invalidation)) {
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
  ApplicationGateway,
  { scope: SidebarSnapshotScope; revision: number }
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
  gateway: ApplicationGateway,
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
  sidebarScopes.set(gateway, { scope, revision: gateway.connectionRevision });
  const stop = subscribeSidebarBootRetirement(
    () => scope,
    () => sidebarScopes.delete(gateway),
  );
  return () => {
    stop();
    sidebarScopes.delete(gateway);
  };
}

export function consumeSidebarBootScope(gateway: ApplicationGateway) {
  const admitted = sidebarScopes.get(gateway);
  sidebarScopes.delete(gateway);
  return admitted;
}
