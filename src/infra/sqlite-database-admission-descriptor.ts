import fs, { type BigIntStats } from "node:fs";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import { hasErrnoCode } from "./errno.js";
import {
  readSqliteCleanCloseSealAsync,
  type SqliteCleanCloseSealRefusal,
} from "./sqlite-clean-close-seal.js";
import {
  exchangeSqliteDatabaseAdmission as exchange,
  sqliteDatabaseAdmissionState as state,
} from "./sqlite-database-admission-context.js";
import {
  readSqliteDatabaseAdmissionIdentity as identity,
  isSqliteDatabaseAdmissionRetired as isRetired,
  type Admission,
  type SqliteDatabaseAdmissionLocation,
} from "./sqlite-database-admission-record.js";
import type { SqliteDatabaseCleanCloseSeals } from "./sqlite-database-admission-seal.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  assertDatabaseFileIdentity,
  inspectDatabasePathIdentity,
  readDatabaseIdentityBirthtime,
  type DatabaseFileIdentity,
  type DatabasePathIdentity,
} from "./sqlite-worker-identity.js";

/** Resolve SQLite's absolute URLs and encoded filename form at filesystem boundaries. */
export function resolveSqliteDatabaseFilePath(location: string): string {
  if (!location.startsWith("file:")) {
    return location;
  }
  const [uriFilename = ""] = location.slice("file:".length).split(/[?#]/u, 1);
  return uriFilename.startsWith("/") ? fileURLToPath(location) : decodeURIComponent(uriFilename);
}

function fileIdentity(file: BigIntStats, canonicalPath: string): DatabasePathIdentity {
  return {
    key: `file:${file.dev}:${file.ino}`,
    canonicalPath,
    birthtime: readDatabaseIdentityBirthtime(file),
  };
}

/** Physical admission uses the existing host registry and its single restart-proof owner. */
export function createSqliteDatabaseDescriptorOwner(
  seals: Pick<SqliteDatabaseCleanCloseSeals, "load" | "markLoaded" | "isLoaded">,
) {
  /** Private staging owners await this before dispatching any native consumer of the file.
   * Sync public/offline callers retain their existing entry; they must not open this private token
   * during its first preparation. This is not an asynchronous worker-message receiver.
   */
  function prepareOwnedSqliteDatabaseAdmission(params: {
    location: string;
    expectedIdentity: DatabaseFileIdentity;
    assertCurrent: () => void;
  }): Promise<void> {
    const { expectedIdentity, ...request } = params;
    return prepareDescriptor(request, expectedIdentity).then(() => {});
  }

  type Preparation = {
    location: string;
    assertCurrent: () => void;
    identity?: DatabasePathIdentity;
    expectedIdentity?: DatabaseFileIdentity;
    observedLocation?: SqliteDatabaseAdmissionLocation;
    create?: {
      authorize(canonicalPath: string): void | Promise<void>;
      retain(completion: Promise<void>): void;
    };
  };

  /** The caller owns permission to create; ordinary turn preparation observes absence only. */
  function prepareDescriptor(
    params: Preparation,
    privateStaging?: DatabaseFileIdentity,
  ): Promise<DatabasePathIdentity | undefined> {
    const target = privateStaging
      ? { filename: params.location, create: false }
      : resolveAdmissionTarget(params.location, params.create !== undefined);
    if (!target) {
      return Promise.resolve(undefined);
    }
    const { filename, create } = target;
    let suppliedIdentity = params.identity;
    const prepare = async (): Promise<DatabasePathIdentity | undefined> => {
      if (privateStaging && threadId !== 0) {
        throw new Error("SQLite descriptor preparation belongs to the host");
      }
      params.assertCurrent();
      let observed: DatabasePathIdentity | undefined;
      if (privateStaging) {
        const file = await fs.promises.stat(filename, { bigint: true });
        assertDatabaseFileIdentity(file, privateStaging);
        const canonical = await fs.promises.realpath(filename);
        params.assertCurrent();
        if (canonical !== filename) {
          throw new Error("SQLite private staging location changed before admission");
        }
        observed = fileIdentity(file, canonical);
      } else {
        observed = suppliedIdentity ?? (await inspectDatabasePathIdentity(filename));
        suppliedIdentity = undefined;
        params.assertCurrent();
      }
      if (!observed) {
        return undefined;
      }
      if (
        params.expectedIdentity &&
        (observed.key !== params.expectedIdentity.key ||
          (params.expectedIdentity.birthtime !== undefined &&
            observed.birthtime !== params.expectedIdentity.birthtime))
      ) {
        throw new Error("SQLite Worker path no longer matches its borrowed native owner");
      }
      const exists = observed.key.startsWith("file:");
      const creator = !exists && create ? params.create : undefined;
      if (!exists && !creator) {
        return observed;
      }
      const key = `${observed.key.slice("file:".length)}:${observed.birthtime}`;
      if (params.observedLocation && params.observedLocation.identity !== key) {
        throw new Error("SQLite database changed while retaining its admission identity");
      }
      if (threadId !== 0) {
        // Worker adapters keep borrowing host custody through the existing synchronous exchange.
        // Missing-file creation still belongs to their subsequent native-open grant.
        if (creator) {
          throw new Error("SQLite descriptor creation belongs to the host");
        }
        pathAdmission(filename, key);
        params.assertCurrent();
        return observed;
      }
      const custody = exists ? state.registry.descriptors.get(key) : undefined;
      if (custody) {
        assertDatabaseFileIdentity(custody.file, observed);
        if (
          retainPreparedSqliteDatabaseAdmissionLocation(filename, undefined, {
            identity: key,
            canonicalPath: observed.canonicalPath,
          })
        ) {
          return observed;
        }
      }
      if (creator) {
        await creator.authorize(observed.canonicalPath);
      }
      if (!custody && !privateStaging) {
        params.assertCurrent();
      }
      const accepted = creator ? createDeferredCore() : undefined;
      if (accepted) {
        creator?.retain(accepted.promise);
      }
      let acquired: number | undefined;
      let rollbackDescriptor: number | undefined;
      try {
        const descriptor =
          custody?.descriptor ??
          (acquired = await new Promise<number>((resolve, reject) => {
            fs.open(filename, creator ? "wx" : "r", 0o644, (error, value) =>
              error ? reject(error) : resolve(value),
            );
          }));
        const opened =
          custody && !privateStaging
            ? custody.file
            : await new Promise<BigIntStats>((resolve, reject) => {
                fs.fstat(descriptor, { bigint: true }, (error, value) =>
                  error ? reject(error) : resolve(value),
                );
              });
        if (exists) {
          assertDatabaseFileIdentity(opened, observed);
        }
        if (privateStaging) {
          // No native consumer can open this private token before publication.
          rollbackDescriptor = acquired;
        } else if (!custody) {
          // Ordinary fd custody survives cancellation without publishing native admission.
          state.registry.retainDescriptorCustody(observed.canonicalPath, descriptor, opened);
          accepted?.resolve();
        }
        const physical = exists ? observed : fileIdentity(opened, observed.canonicalPath);
        let refusal: SqliteCleanCloseSealRefusal | undefined;
        const seal = exists
          ? await readSqliteCleanCloseSealAsync(physical.canonicalPath, opened, (reason) => {
              refusal = reason;
            })
          : undefined;
        if (privateStaging) {
          assertDatabaseFileIdentity(
            await fs.promises.stat(filename, { bigint: true }),
            privateStaging,
          );
        } else {
          const currentPath = await inspectDatabasePathIdentity(filename);
          if (
            !currentPath ||
            currentPath.key !== physical.key ||
            currentPath.birthtime !== physical.birthtime ||
            currentPath.canonicalPath !== physical.canonicalPath
          ) {
            throw new Error("SQLite database changed identity during admission");
          }
        }
        params.assertCurrent();
        const current = state.registry.records.get(identity(opened));
        const record =
          !privateStaging && current && !isRetired(current)
            ? current
            : state.registry.retainDescriptor(physical.canonicalPath, descriptor, opened);
        rollbackDescriptor = undefined;
        state.registry.observeLocation(filename, record.identity);
        if (exists) {
          seals.load(record, { seal, refusal });
        } else {
          seals.markLoaded(record);
        }
        return physical;
      } catch (error) {
        if (acquired === undefined) {
          accepted?.resolve();
          if (creator && hasErrnoCode(error, "EEXIST")) {
            return prepare();
          }
        } else {
          // An unverified returned fd may alias a live SQLite lock and must not close.
          accepted?.reject(error);
        }
        if (rollbackDescriptor !== undefined) {
          const descriptor = rollbackDescriptor;
          try {
            await new Promise<void>((resolve, reject) => {
              fs.close(descriptor, (closeError) => (closeError ? reject(closeError) : resolve()));
            });
          } catch (cleanupError) {
            throw createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "SQLite preparation cleanup failed",
              error,
            );
          }
        }
        throw error;
      }
    };
    const prepared = state.descriptorPreparation.then(prepare);
    state.descriptorPreparation = prepared.then(
      () => {},
      () => {},
    );
    return prepared;
  }

  /** Consume already prepared physical custody without beginning another filesystem operation. */
  function retainPreparedSqliteDatabaseAdmissionLocation(
    location: string,
    expectedIdentity?: DatabaseFileIdentity,
    observedLocation?: SqliteDatabaseAdmissionLocation,
  ): boolean {
    const bound = !observedLocation && state.registry.forLocation(location);
    const boundCustody = bound && state.registry.descriptors.get(bound.identity);
    if (
      bound &&
      expectedIdentity?.birthtime !== undefined &&
      bound.physicalIdentity.key === expectedIdentity.key &&
      bound.physicalIdentity.birthtime === expectedIdentity.birthtime &&
      boundCustody &&
      boundCustody.descriptor === bound.descriptor &&
      seals.isLoaded(boundCustody)
    ) {
      // Bound workers already checked this identity; unbound opens discover the current file.
      seals.load(bound);
      return true;
    }
    const custody = observedLocation && state.registry.descriptors.get(observedLocation.identity);
    if (observedLocation && custody && seals.isLoaded(custody)) {
      if (expectedIdentity) {
        assertDatabaseFileIdentity(custody.file, expectedIdentity);
      }
      const current = state.registry.records.get(observedLocation.identity);
      const retained =
        current && !isRetired(current)
          ? current
          : state.registry.retainDescriptor(
              observedLocation.canonicalPath,
              custody.descriptor,
              custody.file,
            );
      // Native open already checked this identity; descriptor custody survives generation retirement.
      state.registry.observeLocation(location, retained.identity);
      seals.markLoaded(retained);
      return true;
    }
    return false;
  }

  function pathAdmission(location: string, observedIdentity?: string): Admission | undefined {
    try {
      let retained = state.registry.forLocation(location);
      if (!retained) {
        let physicalIdentity = observedIdentity;
        if (physicalIdentity === undefined && threadId !== 0) {
          const observed = fs.statSync(location, { bigint: true });
          if (!observed.isFile()) {
            return undefined;
          }
          physicalIdentity = identity(observed);
        }
        // Native workers identify the file so the host can reuse retained descriptor custody.
        exchange(
          location,
          undefined,
          false,
          physicalIdentity !== undefined && threadId !== 0
            ? { identity: physicalIdentity, canonicalPath: fs.realpathSync.native(location) }
            : undefined,
        );
        retained = state.registry.forLocation(location);
      }
      if (retained) {
        seals.load(retained);
        return retained;
      }
      const observed = fs.statSync(location, { bigint: true });
      if (!observed.isFile()) {
        return undefined;
      }
      const key = identity(observed);
      const previous = state.registry.records.get(key);
      if (previous && !isRetired(previous)) {
        state.registry.observeLocation(location, key);
        seals.load(previous);
        return previous;
      }
      // A worker's unmanaged descriptors close on exit and can release sibling SQLite POSIX locks.
      // Core workers borrow host custody through the existing exchange; raw workers keep native checks.
      if (threadId !== 0) {
        return undefined;
      }
      const descriptor =
        state.registry.descriptors.get(key)?.descriptor ?? fs.openSync(location, "r");
      // Never close a source descriptor while another native connection may hold POSIX locks.
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || identity(opened) !== key) {
        throw new Error("SQLite database changed while retaining its admission identity");
      }
      const record = state.registry.retainDescriptor(
        fs.realpathSync.native(location),
        descriptor,
        opened,
      );
      state.registry.observeLocation(location, record.identity);
      seals.load(record);
      return record;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  function resolveAdmissionTarget(location: string, requestedCreate?: boolean) {
    let filename = location;
    let create = requestedCreate;
    if (!filename || filename === ":memory:") {
      return undefined;
    }
    if (filename.startsWith("file:")) {
      const url = new URL(filename);
      if (url.searchParams.get("mode") === "memory") {
        return undefined;
      }
      if (["ro", "rw"].includes(url.searchParams.get("mode") ?? "")) {
        create = false;
      }
      filename = resolveSqliteDatabaseFilePath(filename);
      if (!filename || filename === ":memory:") {
        return undefined;
      }
    }
    return { filename, create };
  }

  /** Bracket native open so a pathname swap cannot lend the replacement file's admission. */
  function prepareSqliteDatabaseAdmission(
    location: string,
    options: { create?: boolean } = {},
  ): string | undefined {
    const target = resolveAdmissionTarget(location, options.create);
    if (!target) {
      return undefined;
    }
    const { filename, create } = target;
    try {
      const file = fs.statSync(filename, { bigint: true });
      if (!file.isFile()) {
        state.registry.observeLocation(filename, undefined);
        return undefined;
      }
      const observed = identity(file);
      state.registry.observeLocation(filename, observed);
      return observed;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        state.registry.observeLocation(filename, undefined);
        if (!create) {
          return undefined;
        }
        if (threadId !== 0) {
          const managed = state.exchange.getStore() !== undefined;
          exchange(filename, true);
          const opened = prepareSqliteDatabaseAdmission(filename);
          if (managed && opened === undefined) {
            throw new Error(`SQLite worker file creation requires host authority: ${filename}`, {
              cause: error,
            });
          }
          return opened;
        }
        let descriptor: number;
        try {
          // Match SQLite's Unix creation mode, including the process umask.
          descriptor = fs.openSync(filename, "wx", 0o644);
        } catch (creationError) {
          if (hasErrnoCode(creationError, "EEXIST")) {
            return prepareSqliteDatabaseAdmission(filename);
          }
          throw creationError;
        }
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const record = state.registry.retainDescriptor(
          fs.realpathSync.native(filename),
          descriptor,
          opened,
        );
        seals.markLoaded(record);
        if (prepareSqliteDatabaseAdmission(filename) !== record.identity) {
          throw new Error("SQLite database changed identity during file creation", {
            cause: error,
          });
        }
        return record.identity;
      }
      throw error;
    }
  }

  return {
    prepareOwnedSqliteDatabaseAdmission,
    prepareSqliteDatabaseAdmissionAsync: (params: Preparation) => prepareDescriptor(params),
    retainPreparedSqliteDatabaseAdmissionLocation,
    prepareSqliteDatabaseAdmission,
    pathAdmission,
  };
}
