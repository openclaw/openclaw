import path from "node:path";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";

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
};

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
      throw new Error("OpenClaw state database read admission is closed");
    }
  };
  const resolve = (pathname: string, preparedIdentity?: DatabasePathIdentity): IdentityRecord => {
    const resolvedPath = path.resolve(pathname);
    const cached = known(resolvedPath);
    if (cached) {
      return cached;
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
          // Unpublished prospective paths have no admitted worker. Keep their
          // records without making unrelated identity lookup failures contagious.
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
      return resolveForNative(pathname)?.identity;
    },
    knownIdentity(pathname: string): DatabasePathIdentity | undefined {
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
        record = { identity, paths: new Set(), generation: {} };
        records.set(identity.key, record);
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
      return () => {
        resources.delete(resource);
      };
    },
    capture(pathname: string): OpenClawStateDatabaseReadAdmission {
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
            throw new Error("OpenClaw state database read admission changed");
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
      const pending = tail.then(async () => {
        const closing = new Set([...resources, ...current.retained]);
        for (const entry of attempts.values()) {
          for (const resource of entry.retained) {
            closing.add(resource);
          }
        }
        const errors: unknown[] = [];
        await Promise.all(
          [...closing].map(async (resource) => {
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
