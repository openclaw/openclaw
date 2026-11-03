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

type PreferencePublication = {
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
    current = { revision: {}, pending: new Set(), readers: new Set() };
    publications.set(key, current);
  }
  return current;
}

export function publishUserPreferencesChange(db: EngineConnection): void {
  const finish = beginPublication(publication(requireOpenClawStateDatabaseIdentity({ db }).key));
  if (!stageSqliteTransactionState(db, { commit: finish, rollback: finish, invalidate: finish })) {
    finish();
  }
}

/** Fence readers before worker dispatch and retain the fence through native settlement. */
export function beginUserPreferenceMutation(admission: OpenClawStateDatabaseReadAdmission) {
  admission.assertCurrent();
  return beginPublication(publication(admission.identity.key));
}

function beginPublication(current: PreferencePublication) {
  const settled = createDeferredCore();
  current.revision = {};
  current.pending.add(settled.promise);
  return () => {
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
