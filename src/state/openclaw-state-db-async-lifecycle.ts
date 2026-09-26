import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STATE_DATABASE_READ_ADMISSION_INVALIDATED = "STATE_DATABASE_READ_ADMISSION_INVALIDATED";

export class StateDatabaseReadAdmissionInvalidatedError extends Error {
  readonly code = STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export function isStateDatabaseReadAdmissionInvalidatedError(error: unknown): boolean {
  return extractErrorCode(error) === STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export type OpenClawStateDatabaseReadAdmission = {
  readonly databasePath: string;
  readonly identity: DatabasePathIdentity;
  assertCurrent: () => void;
};
export type OpenClawStateDatabaseAsyncResource = {
  /** Shared execution resources close only after accepted owners settle their remaining work. */
  phase?: "after-resources";
  close: (identity?: DatabasePathIdentity) => Promise<void>;
};

type IdentityRecord = {
  identity: DatabasePathIdentity;
  paths: Set<string>;
  generation: object;
  admissions: Map<string, OpenClawStateDatabaseReadAdmission>;
};
type ReadSeal = { record?: IdentityRecord };
type CloseAttempt = {
  seal: ReadSeal;
  retained: Set<OpenClawStateDatabaseAsyncResource>;
  pending?: Promise<boolean>;
  queue?: Set<OpenClawStateDatabaseAsyncResource>;
};

type MaintenanceResource = {
  phase:
    | "agent-resources"
    | "agent-handles"
    | "shared-leases"
    | "shared-resources"
    | "shared-references"
    | "shared-handles";
  close: () => void | Promise<void>;
};
type AgentSchemaMigration = {
  agentId: string;
  path: string;
  foundVersion: number;
  supportedVersion: number;
};

export type OpenClawDatabaseMaintenanceScope = {
  readonly ownsSchemaMaintenance: boolean;
  assertOwnerCurrent(this: void, access?: "read"): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  assertAdmission(this: void): void;
  assertReadAdmission(this: void): void;
  addAgentSchemaMigrationCheck(check: (migration: AgentSchemaMigration) => void): void;
  assertAgentSchemaMigration(migration: AgentSchemaMigration): void;
  run<T>(operation: () => T): T;
  track<T>(operation: Promise<T>): Promise<T>;
  own(
    resource: object,
    phase: MaintenanceResource["phase"],
    close: MaintenanceResource["close"],
  ): void;
  close(): Promise<void>;
};

const maintenanceResources = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseMaintenanceResources"),
  () => ({
    current: new AsyncLocalStorage<{ scope: OpenClawDatabaseMaintenanceScope; active: boolean }>(),
    claims: new WeakMap<
      object,
      MaintenanceResource & { scope: OpenClawDatabaseMaintenanceScope; release: () => void }
    >(),
    parents: new WeakMap<OpenClawDatabaseMaintenanceScope, OpenClawDatabaseMaintenanceScope>(),
  }),
);

export function getOpenClawDatabaseMaintenanceScope():
  | OpenClawDatabaseMaintenanceScope
  | undefined {
  return maintenanceResources.current.getStore()?.scope;
}

/** Delayed work acquires its own resources instead of inheriting the completed scope. */
export function runOutsideOpenClawDatabaseMaintenanceScope<T>(operation: () => T): T {
  return maintenanceResources.current.exit(operation);
}

export function isOpenClawDatabaseMaintenanceResourceOwned(
  resource: object,
  scope: OpenClawDatabaseMaintenanceScope,
): boolean {
  return maintenanceResources.claims.get(resource)?.scope === scope;
}

export function getOpenClawDatabaseMaintenanceResourceScope(
  resource: object,
): OpenClawDatabaseMaintenanceScope | undefined {
  return maintenanceResources.claims.get(resource)?.scope;
}

function runMaintenance<T>(scope: OpenClawDatabaseMaintenanceScope, operation: () => T): T {
  const accepted = { scope, active: true };
  try {
    const result = maintenanceResources.current.run(accepted, operation);
    if (result instanceof Promise) {
      const settled = () => {
        accepted.active = false;
      };
      void result.then(settled, settled);
      void scope.track(result);
    } else {
      accepted.active = false;
    }
    return result;
  } catch (error) {
    accepted.active = false;
    throw error;
  }
}

/** Retain one exact resource claim for finite commands while its maintenance scope drains. */
export function captureOpenClawDatabaseMaintenanceResource(
  resource: object,
  expectedScope: OpenClawDatabaseMaintenanceScope,
) {
  const claim = maintenanceResources.claims.get(resource);
  const assertCurrent = () => {
    expectedScope.assertOwnerCurrent();
    if (claim?.scope !== expectedScope || maintenanceResources.claims.get(resource) !== claim) {
      throw new Error("Database maintenance resource owner changed");
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      return runMaintenance(expectedScope, operation);
    },
  };
}

/** A cached handle used by an independent caller remains with the ordinary cache owner. */
export function observeOpenClawDatabaseMaintenanceResource(resource: object | undefined): void {
  if (!resource) {
    return;
  }
  const claim = maintenanceResources.claims.get(resource);
  const current = getOpenClawDatabaseMaintenanceScope();
  if (!claim) {
    return;
  }
  const owner = commonMaintenanceAncestor(claim.scope, current);
  if (owner === claim.scope) {
    return;
  }
  claim.scope.assertAdmission();
  claim.release();
  maintenanceResources.claims.delete(resource);
  if (owner) {
    owner.own(resource, claim.phase, claim.close);
  }
}

function commonMaintenanceAncestor(
  owner: OpenClawDatabaseMaintenanceScope,
  scope: OpenClawDatabaseMaintenanceScope | undefined,
): OpenClawDatabaseMaintenanceScope | undefined {
  const ancestors = new Set<OpenClawDatabaseMaintenanceScope>();
  for (
    let current: OpenClawDatabaseMaintenanceScope | undefined = owner;
    current;
    current = maintenanceResources.parents.get(current)
  ) {
    ancestors.add(current);
  }
  for (let current = scope; current; current = maintenanceResources.parents.get(current)) {
    if (ancestors.has(current)) {
      return current;
    }
  }
  return undefined;
}

/** Associate lexical database work with exact resources, never all files beneath a root. */
export function createOpenClawDatabaseMaintenanceScope(
  options?:
    | {
        schemaMaintenance?: false;
        assertOwnerCurrent?: () => void;
        assertDatabaseAccess?: (databasePath: string) => void;
      }
    | {
        schemaMaintenance: true;
        assertOwnerCurrent: () => void;
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
    assertOwnerCurrent(access) {
      assertOpen();
      if (checkingOwner) {
        if (access === "read") {
          return;
        }
        throw new Error("Database maintenance authority check cannot admit a nested effect");
      }
      checkingOwner = true;
      try {
        parent?.assertOwnerCurrent(access);
        assertOwnerCurrent?.();
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
      scope.assertAdmission();
      return runMaintenance(scope, operation);
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
    close() {
      if (closing) {
        return closing;
      }
      // A disposer can reenter admission before its first awaited cleanup.
      const completion = createDeferredCore();
      closing = completion.promise;
      void maintenanceResources.current
        .run({ scope, active: true }, async () => {
          while (pending.size || resources.size) {
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
                if (errors.length === 1) {
                  throw errors[0];
                }
                if (errors.length > 1) {
                  throw createSqliteLifecycleAggregateError(
                    errors,
                    "Maintenance resource cleanup failed",
                    errors[0],
                  );
                }
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

/** The cache owns physical identity and admission across drainage and file exclusion. */
export function createOpenClawStateDatabaseAsyncLifecycle() {
  const resources = new Set<OpenClawStateDatabaseAsyncResource>();
  const records = new Map<string, IdentityRecord>();
  const recordsByPath = new Map<string, IdentityRecord>();
  const seals = new Set<ReadSeal>();
  const attempts = new Map<IdentityRecord | undefined, CloseAttempt>();
  let tail = Promise.resolve();

  const known = (pathname: string) =>
    recordsByPath.get(pathname) ?? recordsByPath.get(path.resolve(pathname));
  const bindPath = (record: IdentityRecord, pathname: string) => {
    record.paths.add(pathname);
    if (!recordsByPath.has(pathname)) {
      recordsByPath.set(pathname, record);
    }
  };
  const overlaps = (left: IdentityRecord, right: IdentityRecord) => {
    if (left.identity.key === right.identity.key) {
      return true;
    }
    for (const pathname of left.paths) {
      if (right.paths.has(pathname)) {
        return true;
      }
    }
    return false;
  };
  const isSealed = (record: IdentityRecord) => {
    if (seals.size === 0) {
      return false;
    }
    for (const held of seals) {
      if (held.record === undefined || overlaps(held.record, record)) {
        return true;
      }
    }
    return false;
  };
  const assertOpen = (record: IdentityRecord) => {
    if (isSealed(record)) {
      throw new StateDatabaseReadAdmissionInvalidatedError(
        "OpenClaw state database read admission is closed",
      );
    }
  };
  const findPhysicalRecord = (identity: DatabasePathIdentity): IdentityRecord | undefined => {
    const record = records.get(identity.key);
    if (
      !record ||
      !identity.key.startsWith("file:") ||
      record.paths.has(identity.canonicalPath) ||
      isSealed(record)
    ) {
      return record;
    }
    // A closed, deleted database can leave an inode that a new path reuses.
    // Only cold identity binding probes aliases; warmed captures stay unchanged.
    if (
      [...record.paths].some(
        (pathname) => inspectDatabasePathIdentitySync(pathname)?.key === identity.key,
      )
    ) {
      return record;
    }
    invalidate(record);
    forget(record);
    return undefined;
  };
  const resolve = (
    resolvedPath: string,
    preparedIdentity?: DatabasePathIdentity,
  ): IdentityRecord => {
    const cached = recordsByPath.get(resolvedPath);
    if (cached && (!preparedIdentity || cached.identity.key === preparedIdentity.key)) {
      // Resolve first creation without replacing an established file's admission.
      return !preparedIdentity && cached.identity.key.startsWith("path:")
        ? resolve(resolvedPath, readDatabasePathIdentitySync(resolvedPath))
        : cached;
    }
    const identity = preparedIdentity ?? readDatabasePathIdentitySync(resolvedPath);
    let record = findPhysicalRecord(identity);
    if (!record && identity.key.startsWith("file:")) {
      // A first creation can become visible through an alias before publication.
      // Reconcile unresolved creation facts here, never on warmed captures.
      record = [...records.values()].find((candidate) => {
        if (!candidate.identity.key.startsWith("path:")) {
          return false;
        }
        try {
          return (
            readDatabasePathIdentitySync(candidate.identity.canonicalPath).key === identity.key
          );
        } catch {
          // Creation can still be opening in a worker. Keep its custody until
          // publication or drainage without spreading unrelated lookup failures.
          return false;
        }
      });
      if (record) {
        records.delete(record.identity.key);
        record.identity = identity;
        records.set(identity.key, record);
      }
    }
    if (!record) {
      record = { identity, paths: new Set(), generation: {}, admissions: new Map() };
      records.set(identity.key, record);
    }
    bindPath(record, resolvedPath);
    bindPath(record, identity.canonicalPath);
    return record;
  };
  const resolveForNative = (pathname: string): IdentityRecord | undefined => {
    const resolvedPath = path.resolve(pathname);
    const cached = recordsByPath.get(resolvedPath);
    if (cached) {
      return cached;
    }
    const identity = inspectDatabasePathIdentitySync(resolvedPath);
    return identity ? resolve(resolvedPath, identity) : undefined;
  };
  const invalidate = (record?: IdentityRecord) => {
    for (const current of record ? [record] : records.values()) {
      current.generation = {};
      current.admissions.clear();
    }
  };
  const seal = (record?: IdentityRecord): ReadSeal => {
    invalidate(record);
    const held = { record };
    seals.add(held);
    return held;
  };
  const forget = (record: IdentityRecord) => {
    if (!isSealed(record) && records.get(record.identity.key) === record) {
      records.delete(record.identity.key);
      for (const pathname of record.paths) {
        if (recordsByPath.get(pathname) === record) {
          recordsByPath.delete(pathname);
          // A sealed predecessor keeps close custody until retirement, even if
          // publication has already recorded a replacement at the same path.
          for (const replacement of records.values()) {
            if (replacement.paths.has(pathname)) {
              recordsByPath.set(pathname, replacement);
              break;
            }
          }
        }
      }
    }
  };
  // Keep closure creation off capture's warm branch: V8 otherwise allocates its
  // captured environment even when returning an already retained admission.
  const captureRecord = (
    record: IdentityRecord,
    databasePath: string,
  ): OpenClawStateDatabaseReadAdmission => {
    const previous = record.admissions.get(databasePath);
    if (previous) {
      return previous;
    }
    const generation = record.generation;
    const admission: OpenClawStateDatabaseReadAdmission = Object.freeze({
      databasePath,
      get identity() {
        return record.identity;
      },
      assertCurrent() {
        assertOpen(record);
        if (records.get(record.identity.key) !== record || record.generation !== generation) {
          throw new StateDatabaseReadAdmissionInvalidatedError(
            "OpenClaw state database read admission changed",
          );
        }
      },
    });
    record.admissions.set(databasePath, admission);
    return admission;
  };
  const captureResolved = (databasePath: string): OpenClawStateDatabaseReadAdmission => {
    const record = resolve(databasePath);
    assertOpen(record);
    return captureRecord(record, databasePath);
  };

  return {
    identity(pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity ?? inspectDatabasePathIdentitySync(pathname);
    },
    knownIdentity(this: void, pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity;
    },
    publish(pathname: string): {
      identity: DatabasePathIdentity;
      admission: OpenClawStateDatabaseReadAdmission;
    } {
      const resolvedPath = path.resolve(pathname);
      const identity = readDatabasePathIdentitySync(resolvedPath);
      const previous = recordsByPath.get(resolvedPath);
      let record = findPhysicalRecord(identity);
      if (previous && previous.identity.key !== identity.key) {
        if (previous.identity.key.startsWith("path:") && !record) {
          // First canonical creation binds the same captured admission to its file.
          records.delete(previous.identity.key);
          previous.identity = identity;
          records.set(identity.key, previous);
          record = previous;
        } else {
          invalidate(previous);
          forget(previous);
        }
      }
      if (!record) {
        record = resolve(resolvedPath, identity);
      }
      bindPath(record, resolvedPath);
      bindPath(record, identity.canonicalPath);
      // Private native binding may publish while reads are sealed. Retain its
      // generation now; every later worker use still checks the seal and lifetime.
      return { identity, admission: captureRecord(record, resolvedPath) };
    },
    invalidate(pathname?: string): void {
      if (pathname === undefined) {
        invalidate();
      } else {
        const record = known(pathname);
        if (record) {
          invalidate(record);
        }
      }
    },
    register(resource: OpenClawStateDatabaseAsyncResource): () => void {
      resources.add(resource);
      for (const attempt of attempts.values()) {
        attempt.queue?.add(resource);
      }
      return () => {
        resources.delete(resource);
      };
    },
    capture(this: void, pathname: string): OpenClawStateDatabaseReadAdmission {
      const cached = recordsByPath.get(pathname);
      const retained = cached?.admissions.get(pathname);
      if (cached && retained && cached.identity.key.startsWith("file:")) {
        retained.assertCurrent();
        return retained;
      }
      return captureResolved(path.resolve(pathname));
    },
    holdExclusion(pathname: string): () => void {
      const record = resolve(path.resolve(pathname));
      const held = seal(record);
      return () => {
        seals.delete(held);
        // Replacement can leave a new physical record sharing this logical path.
        for (const current of records.values()) {
          if (overlaps(record, current)) {
            forget(current);
          }
        }
      };
    },
    close(
      pathname: string | undefined,
      retireNative: (identity?: DatabasePathIdentity) => boolean,
    ): Promise<boolean> {
      const record = pathname === undefined ? undefined : resolveForNative(pathname);
      if (pathname !== undefined && !record) {
        // No worker could enter a non-file target. Retire only the caller's exact
        // native path; undefined must not reach resource.close as a global drain.
        return Promise.resolve(retireNative());
      }
      let attempt = attempts.get(record);
      if (attempt?.pending) {
        return attempt.pending;
      }
      if (!attempt) {
        attempt = { seal: seal(record), retained: new Set() };
        attempts.set(record, attempt);
      }
      const current = attempt;
      const pending = tail
        .then(async () => {
          const closing = new Set([...resources, ...current.retained]);
          for (const entry of attempts.values()) {
            for (const resource of entry.retained) {
              closing.add(resource);
            }
          }
          current.queue = closing;
          const errors: unknown[] = [];
          while (current.queue.size) {
            const ordinary = [...current.queue].filter(
              (resource) => resource.phase !== "after-resources",
            );
            // Failed owners retain the transports they may need during a canonical retry.
            if (!ordinary.length && errors.length) {
              for (const resource of current.queue) {
                current.retained.add(resource);
              }
              break;
            }
            const batch = ordinary.length ? ordinary : [...current.queue];
            for (const resource of batch) {
              current.queue.delete(resource);
            }
            await Promise.all(
              batch.map(async (resource) => {
                try {
                  await resource.close(record?.identity);
                  current.retained.delete(resource);
                } catch (error) {
                  // Unregistration cannot abandon a resource whose close failed.
                  current.retained.add(resource);
                  errors.push(error);
                }
              }),
            );
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw createSqliteLifecycleAggregateError(
              errors,
              "OpenClaw state resource drainage failed",
              errors[0],
            );
          }
          const retired = retireNative(record?.identity);
          attempts.delete(record);
          seals.delete(current.seal);
          if (record === undefined) {
            // A successful whole-cache retry also discharges prior failed path closes.
            for (const [key, entry] of attempts) {
              if (!entry.pending) {
                attempts.delete(key);
                seals.delete(entry.seal);
              }
            }
            for (const entry of records.values()) {
              forget(entry);
            }
          } else {
            forget(record);
          }
          return retired;
        })
        .finally(() => {
          current.queue = undefined;
        });
      current.pending = pending;
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      void pending.catch(() => {
        // Keep the seal and failed resource custody, while allowing an explicit retry.
        current.pending = undefined;
      });
      return pending;
    },
  };
}
