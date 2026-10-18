import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import { getExistingOpenClawStateSchemaPath } from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

const pendingReads = new Map<
  string,
  ReturnType<typeof executeExistingOpenClawStateRead<{ type: "userProfiles.catalog" }>>
>();

/** Share only hydration; catalog consumers keep independent admission, authority, and leases. */
export function readUserProfileCatalogSnapshot(
  options: OpenClawStateDatabaseOptions,
  revision: { identityKey: string; profileRevision: number; bindingRevision: number },
) {
  const key =
    options.env ||
    options.database ||
    getOpenClawDatabaseMaintenanceScope() ||
    getExistingOpenClawStateSchemaPath() ||
    getActiveOpenClawStateDatabaseReadSnapshot(options)
      ? undefined
      : JSON.stringify([revision.identityKey, revision.profileRevision, revision.bindingRevision]);
  let pending = key && pendingReads.get(key);
  if (!pending) {
    pending = executeExistingOpenClawStateRead(
      options,
      { type: "userProfiles.catalog" },
      { current: true },
    ).finally(() => {
      if (key) {
        pendingReads.delete(key);
      }
    });
    if (key) {
      pendingReads.set(key, pending);
    }
  }
  return pending;
}
