import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { tryCreateGatewaySchemaFenceDelegate } from "../infra/state-database-coordinator.js";
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
  close: (identity?: DatabasePathIdentity) => Promise<void>;
};

type IdentityRecord = {
  identity: DatabasePathIdentity;
  paths: Set<string>;
  generation: object;
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
    | "shared-resources"
    | "shared-references"
    | "shared-handles";
  close: () => void | Promise<void>;
};
type SchemaDelegateFactory = (
  params: Parameters<typeof tryCreateGatewaySchemaFenceDelegate>[0],
) => ReturnType<typeof tryCreateGatewaySchemaFenceDelegate>;

export type OpenClawDatabaseMaintenanceScope = {
  readonly ownsSchemaMaintenance: boolean;
  assertAdmission(): void;
  run<T>(operation: () => T): T;
  track<T>(operation: Promise<T>): Promise<T>;
  own(
    resource: object,
    phase: MaintenanceResource["phase"],
    close: MaintenanceResource["close"],
  ): void;
  close(): Promise<void>;
  createSchemaFenceDelegate: SchemaDelegateFactory;
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
  createSchemaFenceDelegate?: SchemaDelegateFactory,
): OpenClawDatabaseMaintenanceScope {
  const parent = getOpenClawDatabaseMaintenanceScope();
  const schemaDelegateFactory =
    createSchemaFenceDelegate ??
    (parent?.ownsSchemaMaintenance ? parent.createSchemaFenceDelegate : undefined);
  const pending = new Set<Promise<unknown>>();
  const resources = new Map<object, MaintenanceResource>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Database maintenance resource scope is closed");
    }
  };
  const scope: OpenClawDatabaseMaintenanceScope = {
    ownsSchemaMaintenance: schemaDelegateFactory !== undefined,
    assertAdmission() {
      assertOpen();
      const inherited = maintenanceResources.current.getStore();
      if (closing && !(inherited?.scope === scope && inherited.active)) {
        throw new Error("Database maintenance resource admission is closed");
      }
    },
    run(operation) {
      scope.assertAdmission();
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
    createSchemaFenceDelegate(params) {
      assertOpen();
      return schemaDelegateFactory?.(params);
    },
    close() {
      return (closing ??= maintenanceResources.current
        .run({ scope, active: true }, async () => {
          while (pending.size || resources.size) {
            while (pending.size) {
              await Promise.allSettled(pending);
            }
            // Agent lease release can create shared-state handles during cleanup.
            for (const phase of [
              "agent-resources",
              "agent-handles",
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
                    await resource.close();
                    resources.delete(key);
                    maintenanceResources.claims.delete(key);
                  }),
                );
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
          closed = true;
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        }));
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
  const seals = new Set<ReadSeal>();
  const attempts = new Map<IdentityRecord | undefined, CloseAttempt>();
  let tail = Promise.resolve();

  const known = (pathname: string) => {
    const resolvedPath = path.resolve(pathname);
    return [...records.values()].find((record) => record.paths.has(resolvedPath));
  };
  const overlaps = (left: IdentityRecord, right: IdentityRecord) =>
    left.identity.key === right.identity.key ||
    [...left.paths].some((pathname) => right.paths.has(pathname));
  const isSealed = (record: IdentityRecord) =>
    [...seals].some((held) => held.record === undefined || overlaps(held.record, record));
  const assertOpen = (record: IdentityRecord) => {
    if (isSealed(record)) {
      throw new StateDatabaseReadAdmissionInvalidatedError(
        "OpenClaw state database read admission is closed",
      );
    }
  };
  const resolve = (pathname: string, preparedIdentity?: DatabasePathIdentity): IdentityRecord => {
    const resolvedPath = path.resolve(pathname);
    const cached = known(resolvedPath);
    if (cached && (!preparedIdentity || cached.identity.key === preparedIdentity.key)) {
      // Resolve first creation without replacing an established file's admission.
      return !preparedIdentity && cached.identity.key.startsWith("path:")
        ? resolve(resolvedPath, readDatabasePathIdentitySync(resolvedPath))
        : cached;
    }
    const identity = preparedIdentity ?? readDatabasePathIdentitySync(resolvedPath);
    let record = records.get(identity.key);
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
      record = { identity, paths: new Set(), generation: {} };
      records.set(identity.key, record);
    }
    record.paths.add(resolvedPath).add(identity.canonicalPath);
    return record;
  };
  const resolveForNative = (pathname: string): IdentityRecord | undefined => {
    const cached = known(pathname);
    if (cached) {
      return cached;
    }
    const identity = inspectDatabasePathIdentitySync(pathname);
    return identity ? resolve(pathname, identity) : undefined;
  };
  const invalidate = (record?: IdentityRecord) => {
    for (const current of record ? [record] : records.values()) {
      current.generation = {};
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
    }
  };

  return {
    identity(pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity ?? inspectDatabasePathIdentitySync(pathname);
    },
    knownIdentity(this: void, pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity;
    },
    publish(pathname: string): DatabasePathIdentity {
      const resolvedPath = path.resolve(pathname);
      const identity = readDatabasePathIdentitySync(resolvedPath);
      const previous = known(resolvedPath);
      let record = records.get(identity.key);
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
      record.paths.add(resolvedPath).add(identity.canonicalPath);
      return identity;
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
      const databasePath = path.resolve(pathname);
      const record = resolve(databasePath);
      assertOpen(record);
      const generation = record.generation;
      return {
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
      };
    },
    holdExclusion(pathname: string): () => void {
      const record = resolve(pathname);
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
            const batch = [...current.queue];
            current.queue.clear();
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
