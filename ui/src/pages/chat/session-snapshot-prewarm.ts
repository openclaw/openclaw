import {
  sameBootRecordOwner,
  subscribeBootRecordChanges,
  type BootRecord,
} from "../../app/boot-record.ts";
import type { SidebarSnapshotModel } from "../../components/sidebar-snapshot-data.ts";
import { readStoredChatSnapshotRecord } from "./session-snapshot-database.ts";
import {
  sidebarSnapshotInvalidationMatches,
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

type PreparedSnapshotRead = ReturnType<
  typeof import("./session-snapshot-store.ts").readPrewarmedChatSnapshot
>;

type PrewarmedSnapshot = {
  cacheKey: string;
  cancelled: boolean;
  promise: Promise<unknown>;
  prepared?: {
    promise: PreparedSnapshotRead;
    snapshot?: Awaited<PreparedSnapshotRead>;
  };
};

let pending: PrewarmedSnapshot | undefined;
export let prewarmedHistoryStateValidator:
  | typeof import("../../lib/protocol-validators.generated/history-state.js").isChatHistoryState
  | undefined;

export async function loadChatHistoryStateValidator() {
  const { isChatHistoryState } =
    await import("../../lib/protocol-validators.generated/history-state.js");
  prewarmedHistoryStateValidator = isChatHistoryState;
  return isChatHistoryState;
}

export function peekPrewarmedChatSnapshot(): PrewarmedSnapshot | undefined {
  return pending;
}

export function readSharedPrewarm(entry: PrewarmedSnapshot, read: () => PreparedSnapshotRead) {
  const prepared: NonNullable<PrewarmedSnapshot["prepared"]> = (entry.prepared ??= {
    promise: read().then((snapshot) => {
      prepared.snapshot = snapshot;
      return snapshot;
    }),
  });
  return prepared;
}

export function discardPrewarmedChatSnapshot(cacheKey?: string): void {
  if (pending && (cacheKey === undefined || pending.cacheKey === cacheKey)) {
    pending.cancelled = true;
    pending = undefined;
  }
}

export async function prewarmChatSnapshot(cacheKey: string): Promise<void> {
  discardPrewarmedChatSnapshot();
  const generation = snapshotStoreGeneration;
  const entry: PrewarmedSnapshot = {
    cacheKey,
    cancelled: false,
    promise: readStoredChatSnapshotRecord(cacheKey)
      .then((record) =>
        entry.cancelled || generation !== snapshotStoreGeneration ? undefined : record,
      )
      .catch(() => undefined),
  };
  pending = entry;
  // Validate once before mount; dispatch reads facts without adopting display rows.
  try {
    const [{ readPrewarmedChatSnapshot }] = await Promise.all([
      import("./session-snapshot-store.ts"),
      loadChatHistoryStateValidator(),
    ]);
    if (pending === entry) {
      await readPrewarmedChatSnapshot(cacheKey);
    }
  } catch {}
}

export function consumePrewarmedChatSnapshot(cacheKey: string): PrewarmedSnapshot | undefined {
  if (pending?.cacheKey !== cacheKey) {
    return undefined;
  }
  const prewarm = pending;
  pending = undefined;
  return prewarm;
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
