import { UI_RAIL_SHORTCUTS_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import { readUserProfileVersion } from "./user-profile-events.js";

type PreferenceChange = { profileId: string; keys: readonly string[] };
type PreferencePublication = {
  sidebarOrders: Map<string, { aliases: ReadonlySet<string>; order: Promise<readonly string[]> }>;
  revision: object;
  pending: Set<Promise<void>>;
  readers: Set<Promise<void>>;
};
const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.userPreferences.publications"),
  () => {
    const stores = new Map<string, PreferencePublication>();
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.identity) {
        stores.delete(event.identity.key);
      }
    });
    return stores;
  },
);

function publication(key: string): PreferencePublication {
  let current = publications.get(key);
  if (!current) {
    current = { sidebarOrders: new Map(), revision: {}, pending: new Set(), readers: new Set() };
    publications.set(key, current);
  }
  return current;
}

/** Only the preference owner retains this read-through projection; no read writes user data. */
export function readPublishedSidebarOrder(
  admission: OpenClawStateDatabaseReadAdmission,
  profileId: string,
  aliases: ReadonlySet<string>,
  load: () => Promise<readonly string[]>,
) {
  admission.assertCurrent();
  const entries = publication(admission.identity.key).sidebarOrders;
  const existing = entries.get(profileId);
  if (existing) {
    return existing.order;
  }
  const order = load().catch((error: unknown) => {
    if (entries.get(profileId)?.order === order) {
      entries.delete(profileId);
    }
    throw error;
  });
  if (entries.size >= 256) {
    const oldest = entries.keys().next();
    if (!oldest.done) {
      entries.delete(oldest.value);
    }
  }
  entries.set(profileId, { aliases, order });
  return order;
}

export function publishUserPreferencesChange(
  db: EngineConnection,
  change?: PreferenceChange,
): void {
  const finish = beginPublication(
    publication(requireOpenClawStateDatabaseIdentity({ db }).key),
    change,
  );
  if (!stageSqliteTransactionState(db, { commit: finish, rollback: finish, invalidate: finish })) {
    finish();
  }
}

/** Fence readers before worker dispatch and retain the fence through native settlement. */
export function beginUserPreferenceMutation(
  admission: OpenClawStateDatabaseReadAdmission,
  change?: PreferenceChange,
) {
  admission.assertCurrent();
  return beginPublication(publication(admission.identity.key), change);
}

function beginPublication(current: PreferencePublication, change?: PreferenceChange) {
  const invalidateSidebar = () => {
    // Profile merges can move preferences between owners.
    if (!change) {
      current.sidebarOrders.clear();
      return;
    }
    if (!change.keys.includes(UI_RAIL_SHORTCUTS_PREFERENCE_KEY)) {
      return;
    }
    for (const [id, snapshot] of current.sidebarOrders) {
      if (id === change.profileId || snapshot.aliases.has(change.profileId)) {
        current.sidebarOrders.delete(id);
      }
    }
  };
  invalidateSidebar();
  const settled = createDeferredCore();
  current.revision = {};
  current.pending.add(settled.promise);
  return () => {
    invalidateSidebar();
    current.revision = {};
    current.pending.delete(settled.promise);
    settled.resolve();
  };
}

export async function captureUserPreferenceRead(admission: OpenClawStateDatabaseReadAdmission) {
  const current = publication(admission.identity.key);
  while (current.pending.size) {
    await Promise.all(current.pending);
  }
  admission.assertCurrent();
  const revision = current.revision;
  // Profile merges can move preferences through the profile mutation owner.
  const profileRevision = readUserProfileVersion();
  return () => {
    admission.assertCurrent();
    return (
      publications.get(admission.identity.key) === current &&
      current.revision === revision &&
      current.pending.size === 0 &&
      readUserProfileVersion() === profileRevision
    );
  };
}

/** Called after a pin writer has published pending intent, before it reserves a worker. */
export async function waitForUserPreferenceReadPermits(
  admission: OpenClawStateDatabaseReadAdmission,
) {
  const current = publication(admission.identity.key);
  while (current.readers.size) {
    await Promise.all(current.readers);
  }
  admission.assertCurrent();
}

/** Native one-shot writes cannot wait while holding a synchronous transaction. */
export function assertUserPreferenceWriteNotHeld(db: EngineConnection): void {
  if (publication(requireOpenClawStateDatabaseIdentity({ db }).key).readers.size) {
    throw new Error("Personal session pins are retained by session maintenance; retry the write.");
  }
}

/** Retain a validated snapshot only while this native cleanup can still commit. */
export function retainUserPreferenceRead(
  admission: OpenClawStateDatabaseReadAdmission,
  isCurrent: () => boolean,
  operation: RetainedWorkerTransactionAdmission,
): void {
  admission.assertCurrent();
  if (!isCurrent()) {
    throw new Error("Personal session pin snapshot changed before maintenance admission");
  }
  const current = publication(admission.identity.key);
  const released = createDeferredCore();
  current.readers.add(released.promise);
  afterUserPreferenceOperationSettled(operation, () => {
    current.readers.delete(released.promise);
    released.resolve();
  });
}

/** Result delivery may fail before the native owner is stopped. */
export function afterUserPreferenceOperationSettled(
  operation: RetainedWorkerTransactionAdmission,
  finish: () => void,
): void {
  void operation.settled.then((settlement) => {
    if (settlement.kind !== "unknown" || settlement.nativeStopped) {
      finish();
    } else {
      void operation.nativeStopped?.then(finish);
    }
  });
}
