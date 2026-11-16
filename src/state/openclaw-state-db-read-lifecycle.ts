import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  findChangedDatabasePaths,
  inspectDatabasePathIdentity,
  readDatabasePathIdentity,
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  StateDatabaseReadAdmissionInvalidatedError,
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
  type OpenClawStateIntegrityAdmission,
  type OpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

type IdentityRecord = {
  readonly coordinationKey: string;
  identity: DatabasePathIdentity;
  paths: Set<string>;
  generation: { integrity: OpenClawStateIntegrityAdmission };
  admissions: Map<string, OpenClawStateDatabaseReadAdmission>;
};
type ReadSeal = { record?: IdentityRecord };
type CloseAttempt = {
  /** Absent after failed drainage released reads; the next attempt seals again. */
  seal?: ReadSeal;
  /** A published replacement keeps reads sealed until this record's native handle retires. */
  superseded?: true;
  retained: Set<OpenClawStateDatabaseAsyncResource>;
  pending?: Promise<boolean>;
  queue?: Set<OpenClawStateDatabaseAsyncResource>;
};

/** The cache owns physical identity and admission across drainage and file exclusion. */
export function createOpenClawStateDatabaseAsyncLifecycle() {
  const resources = new Set<OpenClawStateDatabaseAsyncResource>();
  const records = new Map<string, IdentityRecord>();
  const recordsByPath = new Map<string, IdentityRecord>();
  const seals = new Set<ReadSeal>();
  const attempts = new Map<IdentityRecord | undefined, CloseAttempt>();
  let tail = Promise.resolve();
  const proofFor = () => {
    const proof = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    new BigInt64Array(proof)[0] = -1n;
    return proof;
  };
  const generationFor = (identity: DatabasePathIdentity) => {
    const revision = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    const lifetime = {
      revision: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
      epoch: 0n,
    };
    return { integrity: { identity, lifetime, revision, epoch: 0n, proof: proofFor() } };
  };

  const publishCreatedIdentity = (record: IdentityRecord, identity: DatabasePathIdentity) => {
    // Pre-creation integrity cannot certify the newly bound physical file.
    Atomics.add(new BigInt64Array(record.generation.integrity.revision), 0, 1n);
    Atomics.add(new BigInt64Array(record.generation.integrity.lifetime.revision), 0, 1n);
    records.delete(record.identity.key);
    record.identity = identity;
    record.generation.integrity.identity = identity;
    records.set(identity.key, record);
  };

  const known = (pathname: string) =>
    recordsByPath.get(pathname) ?? recordsByPath.get(resolveDatabasePath({ path: pathname }));
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
  // A failed path close keeps custody after releasing reads, so its retry still
  // targets the identity whose native handle and resources it failed to retire.
  const hasCloseCustody = (record: IdentityRecord) => isSealed(record) || attempts.has(record);
  const assertOpen = (record: IdentityRecord) => {
    if (isSealed(record)) {
      throw new StateDatabaseReadAdmissionInvalidatedError(
        "OpenClaw state database read admission is closed",
      );
    }
  };
  const inspectPreparedPath = (
    pathname: string,
    prepared: ReadonlyMap<string, DatabasePathIdentity | undefined>,
  ) => {
    if (!prepared.has(pathname)) {
      throw new StateDatabaseReadAdmissionInvalidatedError(
        "State database paths changed during preparation",
      );
    }
    return prepared.get(pathname);
  };
  const readObservedPath = (
    pathname: string,
    prepared?: ReadonlyMap<string, DatabasePathIdentity | undefined>,
  ) => {
    if (!prepared) {
      return readDatabasePathIdentitySync(pathname);
    }
    const identity = inspectPreparedPath(pathname, prepared);
    if (!identity) {
      throw new Error("SQLite worker database path must identify a regular file");
    }
    return identity;
  };
  const findPhysicalRecord = (
    identity: DatabasePathIdentity,
    prepared?: ReadonlyMap<string, DatabasePathIdentity | undefined>,
  ): IdentityRecord | undefined => {
    const record = records.get(identity.key);
    if (!record || !identity.key.startsWith("file:") || hasCloseCustody(record)) {
      return record;
    }
    // Cold binding retires vanished paths even when another hardlink keeps the file alive.
    // Warm captures use the retained admission without polling the filesystem.
    const changedPaths = prepared
      ? [...record.paths].filter(
          (pathname) => inspectPreparedPath(pathname, prepared)?.key !== identity.key,
        )
      : findChangedDatabasePaths(record.paths, identity);
    for (const pathname of changedPaths) {
      record.admissions.delete(pathname);
      record.paths.delete(pathname);
      if (recordsByPath.get(pathname) === record) {
        recordsByPath.delete(pathname);
      }
    }
    if (record.paths.size > 0) {
      if (!record.paths.has(record.identity.canonicalPath)) {
        record.identity = identity;
        record.generation.integrity.identity = identity;
      }
      return record;
    }
    invalidate(record);
    forget(record);
    return undefined;
  };
  const resolve = (
    resolvedPath: string,
    preparedIdentity?: DatabasePathIdentity,
    prepared?: ReadonlyMap<string, DatabasePathIdentity | undefined>,
  ): IdentityRecord => {
    const cached = recordsByPath.get(resolvedPath);
    if (cached && (!preparedIdentity || cached.identity.key === preparedIdentity.key)) {
      // Resolve first creation without replacing an established file's admission.
      return !preparedIdentity && cached.identity.key.startsWith("path:")
        ? resolve(resolvedPath, readObservedPath(resolvedPath, prepared), prepared)
        : cached;
    }
    const identity = preparedIdentity ?? readObservedPath(resolvedPath, prepared);
    let record = findPhysicalRecord(identity, prepared);
    if (!record && identity.key.startsWith("file:")) {
      // A first creation can become visible through an alias before publication.
      // Reconcile unresolved creation facts here, never on warmed captures.
      record = [...records.values()].find((candidate) => {
        if (!candidate.identity.key.startsWith("path:")) {
          return false;
        }
        try {
          return readObservedPath(candidate.identity.canonicalPath, prepared).key === identity.key;
        } catch (error) {
          if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
            throw error;
          }
          // Creation can still be opening in a worker. Keep its custody until
          // publication or drainage without spreading unrelated lookup failures.
          return false;
        }
      });
      if (record) {
        publishCreatedIdentity(record, identity);
      }
    }
    if (!record) {
      record = {
        coordinationKey: identity.key,
        identity,
        paths: new Set(),
        generation: generationFor(identity),
        admissions: new Map(),
      };
      records.set(identity.key, record);
    }
    bindPath(record, resolvedPath);
    bindPath(record, identity.canonicalPath);
    return record;
  };
  const resolveForNative = (pathname: string): IdentityRecord | undefined => {
    const resolvedPath = resolveDatabasePath({ path: pathname });
    const cached = recordsByPath.get(resolvedPath);
    if (cached) {
      return cached;
    }
    const identity = inspectDatabasePathIdentitySync(resolvedPath);
    return identity ? resolve(resolvedPath, identity) : undefined;
  };
  const invalidate = (record?: IdentityRecord) => {
    for (const current of record ? [record] : records.values()) {
      Atomics.store(new BigInt64Array(current.generation.integrity.revision), 0, -1n);
      Atomics.store(new BigInt64Array(current.generation.integrity.lifetime.revision), 0, -1n);
      current.generation = generationFor(current.identity);
      current.admissions.clear();
    }
  };
  const seal = (record?: IdentityRecord): ReadSeal => {
    invalidate(record);
    const held = { record };
    seals.add(held);
    return held;
  };
  const release = (attempt: CloseAttempt) => {
    if (attempt.seal) {
      seals.delete(attempt.seal);
      attempt.seal = undefined;
    }
  };
  const forget = (record: IdentityRecord) => {
    if (!hasCloseCustody(record) && records.get(record.identity.key) === record) {
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
  const retireReplacedRecord = (record: IdentityRecord) => {
    const failed = attempts.get(record);
    if (failed) {
      // The replaced file still has unretired native custody. Its path stays
      // bound to that record, so reads there wait for the close retry.
      failed.superseded = true;
      failed.seal ??= seal(record);
    } else {
      invalidate(record);
    }
    forget(record);
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
      coordinationKey: record.coordinationKey,
      get identity() {
        return record.identity;
      },
      captureIntegrity() {
        admission.assertCurrent();
        const current = generation.integrity;
        const epoch = Atomics.load(new BigInt64Array(current.revision), 0);
        const lifetimeEpoch = Atomics.load(new BigInt64Array(current.lifetime.revision), 0);
        if (epoch !== current.epoch || lifetimeEpoch !== current.lifetime.epoch) {
          generation.integrity = {
            ...current,
            identity: record.identity,
            lifetime: { revision: current.lifetime.revision, epoch: lifetimeEpoch },
            epoch,
            proof: proofFor(),
          };
        }
        return generation.integrity;
      },
      assertCurrent() {
        assertOpen(record);
        if (
          records.get(record.identity.key) !== record ||
          record.generation !== generation ||
          record.admissions.get(databasePath) !== admission
        ) {
          throw new StateDatabaseReadAdmissionInvalidatedError(
            "OpenClaw state database read admission changed",
          );
        }
      },
    });
    record.admissions.set(databasePath, admission);
    return admission;
  };
  const register = (resource: OpenClawStateDatabaseAsyncResource): (() => void) => {
    resources.add(resource);
    for (const attempt of attempts.values()) {
      attempt.queue?.add(resource);
    }
    return () => {
      resources.delete(resource);
    };
  };
  const capture = (
    pathname: string,
    preparedIdentity?: DatabasePathIdentity,
    prepared?: ReadonlyMap<string, DatabasePathIdentity | undefined>,
  ): OpenClawStateDatabaseReadAdmission => {
    const cached = recordsByPath.get(pathname);
    const retained = cached?.admissions.get(pathname);
    if (cached && retained && cached.identity.key.startsWith("file:")) {
      retained.assertCurrent();
      return retained;
    }
    const databasePath = resolveDatabasePath({ path: pathname });
    const record = resolve(databasePath, preparedIdentity, prepared);
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
    integrity(this: void, pathname: string): OpenClawStateIntegrityAdmission | undefined {
      const record = resolveForNative(pathname);
      return record && !isSealed(record)
        ? captureRecord(record, resolveDatabasePath({ path: pathname })).captureIntegrity?.()
        : undefined;
    },
    publish(
      pathname: string,
      preparedIdentity?: DatabasePathIdentity,
    ): {
      identity: DatabasePathIdentity;
      admission: OpenClawStateDatabaseReadAdmission;
    } {
      const resolvedPath = resolveDatabasePath({ path: pathname });
      const identity = preparedIdentity ?? readDatabasePathIdentitySync(resolvedPath);
      const previous = recordsByPath.get(resolvedPath);
      // Warm worker publication keeps captured facts; cold binding still retires vanished aliases.
      let record =
        preparedIdentity && previous?.identity.key === identity.key
          ? records.get(identity.key)
          : findPhysicalRecord(identity);
      if (previous && previous.identity.key !== identity.key) {
        if (previous.identity.key.startsWith("path:") && !record) {
          // First canonical creation binds the same captured admission to its file.
          publishCreatedIdentity(previous, identity);
          record = previous;
        } else {
          retireReplacedRecord(previous);
        }
      }
      if (!record) {
        record = resolve(resolvedPath, identity);
      }
      bindPath(record, resolvedPath);
      // A retained actor's opening path cannot restore an alias retired by relocation.
      // Native publication has just observed its own canonical alias.
      bindPath(record, preparedIdentity ? record.identity.canonicalPath : identity.canonicalPath);
      // Private native binding may publish while reads are sealed. Retain its
      // generation now; every later worker use still checks the seal and lifetime.
      return { identity, admission: captureRecord(record, resolvedPath) };
    },
    async retireChangedAdmission(admission: OpenClawStateDatabaseReadAdmission): Promise<void> {
      admission.assertCurrent();
      const record = records.get(admission.identity.key);
      const observed = await readDatabasePathIdentity(admission.databasePath);
      admission.assertCurrent();
      if (record && record.identity.key !== observed.key) {
        // Failed opening retires only its predecessor; later admission qualifies the successor.
        retireReplacedRecord(record);
      }
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
    register,
    capture,
    async captureAsync(
      this: void,
      requestedPath: string,
    ): Promise<OpenClawStateDatabaseReadAdmission> {
      const databasePath = resolveDatabasePath({ path: requestedPath });
      const knownRecord = known(databasePath);
      if (knownRecord?.identity.key.startsWith("file:")) {
        return capture(databasePath, knownRecord.identity);
      }
      const original = knownRecord ? capture(databasePath, knownRecord.identity) : undefined;
      let identityRead: Promise<DatabasePathIdentity> | undefined;
      let operation: Promise<OpenClawStateDatabaseReadAdmission> | undefined;
      const unregister = register({
        async close(target) {
          const identity = target ? await identityRead?.catch(() => undefined) : undefined;
          if (
            !target ||
            identity?.key === target.key ||
            identity?.canonicalPath === target.canonicalPath
          ) {
            await operation?.catch(() => undefined);
          }
        },
      });
      try {
        const readingIdentity = readDatabasePathIdentity(databasePath);
        identityRead = readingIdentity;
        operation = (async () => {
          const identity = await readingIdentity;
          const physical = records.get(identity.key);
          const generation = physical?.generation;
          const prepared = new Map<string, DatabasePathIdentity | undefined>([
            [databasePath, identity],
          ]);
          if (physical && identity.key.startsWith("file:") && !hasCloseCustody(physical)) {
            await Promise.all(
              [...physical.paths].map(async (pathname) => {
                if (!prepared.has(pathname)) {
                  prepared.set(pathname, await inspectDatabasePathIdentity(pathname));
                }
              }),
            );
          }
          if (
            identity.key.startsWith("file:") &&
            (!physical ||
              (!hasCloseCustody(physical) &&
                [...physical.paths].every(
                  (pathname) => prepared.get(pathname)?.key !== identity.key,
                )))
          ) {
            for (const candidate of records.values()) {
              const pathname = candidate.identity.canonicalPath;
              if (candidate.identity.key.startsWith("path:") && !prepared.has(pathname)) {
                prepared.set(
                  pathname,
                  await inspectDatabasePathIdentity(pathname).catch(() => undefined),
                );
              }
            }
          }
          original?.assertCurrent();
          if (
            physical &&
            (records.get(identity.key) !== physical || physical.generation !== generation)
          ) {
            throw new StateDatabaseReadAdmissionInvalidatedError(
              "State database admission changed during preparation",
            );
          }
          return capture(databasePath, identity, prepared);
        })();
        return await operation;
      } finally {
        unregister();
      }
    },
    holdExclusion(pathname: string): () => void {
      const record = resolve(resolveDatabasePath({ path: pathname }));
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
      retireNative: (identity?: DatabasePathIdentity) => boolean | Promise<boolean>,
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
        attempt = { retained: new Set() };
        attempts.set(record, attempt);
      }
      // A retry after failed drainage seals again before draining: invalidation
      // retires admissions captured while reads were open, and the drain below
      // settles resources those readers entered.
      attempt.seal ??= seal(record);
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
                  const identity = record?.identity;
                  if (
                    !identity ||
                    !resource.admission ||
                    identity.key === resource.admission.identity.key
                  ) {
                    await resource.close(identity);
                  }
                  current.retained.delete(resource);
                } catch (error) {
                  // Unregistration cannot abandon a resource whose close failed.
                  current.retained.add(resource);
                  errors.push(error);
                }
              }),
            );
          }
          if (errors.length && !current.superseded) {
            // Native handles were not retired, so the database stays live and
            // reads can resume. Failed resources stay retained for the retry.
            release(current);
          }
          throwSqliteLifecycleErrors(errors, "OpenClaw state resource drainage failed");
          const retired = await retireNative(record?.identity);
          attempts.delete(record);
          release(current);
          if (record === undefined) {
            // A successful whole-cache retry also discharges prior failed path closes.
            for (const [key, entry] of attempts) {
              if (!entry.pending) {
                attempts.delete(key);
                release(entry);
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
        // Failed native retirement keeps its seal; failed drainage released it above.
        // Both keep failed resource custody for an explicit retry.
        current.pending = undefined;
      });
      return pending;
    },
  };
}
