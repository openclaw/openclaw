import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceResources,
  runMaintenance,
  type AgentSchemaMigration,
  type MaintenanceResource,
  type OpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-maintenance-context.js";

export type { OpenClawDatabaseMaintenanceScope } from "./openclaw-state-maintenance-context.js";
export {
  captureOpenClawDatabaseMaintenanceResource,
  getOpenClawDatabaseMaintenanceResourceScope,
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  isOpenClawDatabaseMaintenanceWorkerAccess,
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-maintenance-context.js";

const STATE_DATABASE_READ_ADMISSION_INVALIDATED = "STATE_DATABASE_READ_ADMISSION_INVALIDATED";

export class StateDatabaseReadAdmissionInvalidatedError extends Error {
  readonly code = STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export function isStateDatabaseReadAdmissionInvalidatedError(error: unknown): boolean {
  return extractErrorCode(error) === STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export type OpenClawStateDatabaseReadAdmission = {
  readonly databasePath: string;
  /** Stable across first creation and aliases; coordinates work but grants no authority. */
  readonly coordinationKey: string;
  readonly identity: DatabasePathIdentity;
  captureIntegrity?: () => OpenClawStateIntegrityAdmission;
  assertCurrent: () => void;
};
export type OpenClawStateIntegrityAdmission = {
  identity: DatabasePathIdentity;
  /** Physical-owner lifetime survives renewable schema and integrity proof. */
  readonly lifetime: { readonly revision: SharedArrayBuffer; readonly epoch: bigint };
  readonly revision: SharedArrayBuffer;
  readonly epoch: bigint;
  readonly proof: SharedArrayBuffer;
};
export type OpenClawStateDatabaseAsyncResource = {
  /** Retain the admission getter so first creation can publish its physical identity. */
  admission?: Pick<OpenClawStateDatabaseReadAdmission, "identity">;
  /** Shared execution resources close only after accepted owners settle their remaining work. */
  phase?: "after-resources";
  close: (identity?: DatabasePathIdentity) => Promise<void>;
};

/** Associate lexical database work with exact resources, never all files beneath a root. */
export function createOpenClawDatabaseMaintenanceScope(
  options?:
    | {
        schemaMaintenance?: false;
        sqliteIntegrityCheck?: "quick" | "full";
        assertOwnerCurrent?: (access?: "read") => void;
        assertDatabaseAccess?: (databasePath: string) => void;
      }
    | {
        schemaMaintenance: true;
        sqliteIntegrityCheck?: "quick" | "full";
        assertOwnerCurrent: (access?: "read") => void;
        assertDatabaseAccess?: (databasePath: string) => void;
      },
): OpenClawDatabaseMaintenanceScope {
  const parent = getOpenClawDatabaseMaintenanceScope();
  const assertOwnerCurrent = options?.assertOwnerCurrent;
  const assertDatabaseAccess = options?.assertDatabaseAccess;
  const pending = new Set<Promise<unknown>>();
  const schemaMigrationChecks = new Set<(migration: AgentSchemaMigration) => void>();
  const resources = new Map<object, MaintenanceResource>();
  let closed = false;
  let checkingOwner = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Database maintenance resource scope is closed");
    }
  };
  const assertAdmissionLifecycle = () => {
    assertOpen();
    const inherited = maintenanceResources.current.getStore();
    if (closing && !(inherited?.scope === scope && inherited.active)) {
      throw new Error("Database maintenance resource admission is closed");
    }
  };
  const scope: OpenClawDatabaseMaintenanceScope = {
    ownsSchemaMaintenance:
      options?.schemaMaintenance === true || parent?.ownsSchemaMaintenance === true,
    sqliteIntegrityCheck: options?.sqliteIntegrityCheck ?? parent?.sqliteIntegrityCheck,
    assertOwnerCurrent(access) {
      assertOpen();
      if (checkingOwner) {
        if (access === "read") {
          return;
        }
        // Function names identify the admission without exposing stack paths or arguments.
        const callers = new Error().stack
          ?.split("\n")
          .slice(2, 6)
          .flatMap((line) => line.match(/^\s+at (?:async )?([\w$.]+) \(/u)?.[1] ?? [])
          .join(" <- ")
          .slice(0, 160);
        throw new Error(
          `Database maintenance authority check cannot admit a nested effect (access=effect; caller=${callers || "unknown"})`,
        );
      }
      checkingOwner = true;
      try {
        parent?.assertOwnerCurrent(access);
        assertOwnerCurrent?.(access);
      } finally {
        checkingOwner = false;
      }
    },
    assertAdmission() {
      assertOpen();
      scope.assertOwnerCurrent();
      assertAdmissionLifecycle();
    },
    assertReadAdmission() {
      assertAdmissionLifecycle();
      // Current authority needs policy rows from this same store. Keep its resource
      // custody, but do not recurse into a check already evaluating those rows.
      scope.assertOwnerCurrent("read");
      assertAdmissionLifecycle();
    },
    assertDatabaseAccess(databasePath) {
      scope.assertAdmission();
      if (assertDatabaseAccess) {
        assertDatabaseAccess(databasePath);
      } else if (parent) {
        parent.assertDatabaseAccess(databasePath);
      } else {
        throw new Error("Database maintenance scope does not own this database");
      }
    },
    assertCleanupDatabaseAccess(databasePath) {
      assertOpen();
      // Revoked operation authority cannot strand resources under the same physical owner.
      if (assertDatabaseAccess) {
        assertDatabaseAccess(databasePath);
      } else if (parent) {
        parent.assertCleanupDatabaseAccess(databasePath);
      } else {
        throw new Error("Database maintenance scope does not own this database");
      }
    },
    addAgentSchemaMigrationCheck(check) {
      scope.assertAdmission();
      schemaMigrationChecks.add(check);
    },
    assertAgentSchemaMigration(migration) {
      assertOpen();
      scope.assertOwnerCurrent();
      parent?.assertAgentSchemaMigration(migration);
      for (const check of schemaMigrationChecks) {
        check(migration);
      }
    },
    run(operation) {
      assertAdmissionLifecycle();
      return runMaintenance(scope, () => {
        scope.assertAdmission();
        return operation();
      });
    },
    track(operation) {
      assertOpen();
      pending.add(operation);
      const settled = () => pending.delete(operation);
      void operation.then(settled, settled);
      return operation;
    },
    own(resource, phase, close) {
      assertOpen();
      resources.set(resource, { phase, close });
      maintenanceResources.claims.set(resource, {
        scope,
        phase,
        close,
        release: () => resources.delete(resource),
      });
    },
    close(beforeResources) {
      if (closing) {
        return closing;
      }
      // A disposer can reenter admission before its first awaited cleanup.
      const completion = createDeferredCore();
      closing = completion.promise;
      void maintenanceResources.current
        .run({ scope, active: true }, async () => {
          let beforeSharedResources = beforeResources;
          while (pending.size || resources.size || beforeSharedResources) {
            while (pending.size) {
              await Promise.allSettled(pending);
            }
            // Agent lease release can create shared-state handles during cleanup.
            for (const phase of [
              "agent-resources",
              "agent-handles",
              "shared-leases",
              "shared-resources",
              "shared-references",
              "shared-handles",
            ] as const) {
              if (phase === "shared-leases" && beforeSharedResources) {
                // Retire scope-owned agent resources first, then drain any remaining
                // cached handles while their shared-state lease authority is still live.
                await beforeSharedResources();
                beforeSharedResources = undefined;
              }
              while ([...resources.values()].some((resource) => resource.phase === phase)) {
                // Earlier cleanup can start tracked work using resources in this batch.
                while (pending.size) {
                  await Promise.allSettled(pending);
                }
                const batch = [...resources].filter(([, resource]) => resource.phase === phase);
                const results = await Promise.allSettled(
                  batch.map(async ([key, resource]) => {
                    const claim = maintenanceResources.claims.get(key);
                    await resource.close();
                    if (resources.get(key) === resource) {
                      resources.delete(key);
                    }
                    if (maintenanceResources.claims.get(key) === claim) {
                      maintenanceResources.claims.delete(key);
                    }
                  }),
                );
                // A disposer can admit tracked cleanup before rejecting. Settle
                // that work before reporting failure to its process owner.
                while (pending.size) {
                  await Promise.allSettled(pending);
                }
                const errors = results.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                );
                throwSqliteLifecycleErrors(errors, "Maintenance resource cleanup failed");
              }
            }
          }
          schemaMigrationChecks.clear();
          closed = true;
        })
        .then(completion.resolve, (error: unknown) => {
          closing = undefined;
          completion.reject(error);
        });
      return completion.promise;
    },
  };
  if (parent) {
    maintenanceResources.parents.set(scope, parent);
  }
  return scope;
}
