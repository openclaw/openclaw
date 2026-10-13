import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import { readUserProfileVersion } from "./user-profile-events.js";

type PreferencePublication = { revision: object; pending: Set<Promise<void>> };
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
    current = { revision: {}, pending: new Set() };
    publications.set(key, current);
  }
  return current;
}

export function publishUserPreferencesChange(db: DatabaseSync): void {
  const current = publication(requireOpenClawStateDatabaseIdentity({ db }).key);
  const commit = () => {
    current.revision = {};
  };
  if (!stageSqliteTransactionState(db, { stage: () => {}, rollback: () => {}, commit })) {
    commit();
  }
}

/** Fence readers before worker dispatch and retain the fence through native settlement. */
export function beginUserPreferenceMutation(admission: OpenClawStateDatabaseReadAdmission) {
  admission.assertCurrent();
  const current = publication(admission.identity.key);
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
