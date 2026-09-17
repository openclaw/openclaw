import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";
import { readSqliteBusyTimeout, runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";

const writeAdmissionServices = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWriteAdmissionServices"),
  () => new Map<string, Set<() => void>>(),
);
const writeAdmissionLocations = new WeakMap<DatabaseSync, string | null>();

function writeAdmissionLocation(database: DatabaseSync): string | null {
  const cached = writeAdmissionLocations.get(database);
  if (cached !== undefined) {
    return cached;
  }
  // A native handle's filename is stable; normalize namespace aliases once, without filesystem IO.
  const location = database.location();
  const canonical = location === null ? null : normalizeWriteAdmissionLocation(location);
  writeAdmissionLocations.set(database, canonical);
  return canonical;
}

function normalizeWriteAdmissionLocation(location: string): string {
  const normalized =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(location) : location;
  return process.platform === "win32" && !path.win32.isAbsolute(normalized) ? location : normalized;
}

/** Keep worker-owned lock holders serviceable across connections and module graphs. */
export async function withSqliteWriteAdmissionService<T>(
  database: DatabaseSync,
  service: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const location = writeAdmissionLocation(database);
  if (location === null) {
    throw new Error("SQLite write admission service requires a file-backed database");
  }
  const release = retainSqliteWriteAdmissionService([location], service);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Locations come from the retained native owner; registration grants no write authority. */
export function retainSqliteWriteAdmissionService(
  nativeLocations: readonly string[],
  service: () => void,
): () => void {
  const locations = new Set(nativeLocations.map(normalizeWriteAdmissionLocation));
  const registrations = [...locations].map((location) => {
    const services = writeAdmissionServices.get(location) ?? new Set<() => void>();
    // Separate reservations remain valid when the same owner retains two operations.
    const retained = () => service();
    services.add(retained);
    writeAdmissionServices.set(location, services);
    return { location, services, retained };
  });
  return () => {
    for (const { location, services, retained } of registrations) {
      services.delete(retained);
      if (services.size === 0 && writeAdmissionServices.get(location) === services) {
        writeAdmissionServices.delete(location);
      }
    }
  };
}

/** Retry only native lock acquisition, never an admitted mutation or publication. */
export function runSqliteWriteAdmission<T>(
  database: DatabaseSync,
  acquire: () => T,
  options: {
    /** Lifecycle locks service the original data location, not their hashed lock filename. */
    nativeLocation?: string;
    service?: (service: () => void) => void;
  } = {},
): T {
  const location =
    writeAdmissionServices.size === 0
      ? null
      : options.nativeLocation === undefined
        ? writeAdmissionLocation(database)
        : normalizeWriteAdmissionLocation(options.nativeLocation);
  if (location === null || !writeAdmissionServices.has(location)) {
    return acquire();
  }
  const deadline = performance.now() + readSqliteBusyTimeout(database);
  while (true) {
    let lockFailure: unknown;
    try {
      return runWithSqliteBusyTimeout(
        database,
        Math.min(25, Math.max(0, Math.ceil(deadline - performance.now()))),
        acquire,
      );
    } catch (error) {
      if (!isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      lockFailure = error;
    }
    // Services retain authority and settlement. Their failures must never retry acquisition.
    const services = [...(writeAdmissionServices.get(location) ?? [])];
    for (const service of services) {
      if (writeAdmissionServices.get(location)?.has(service)) {
        if (options.service) {
          options.service(service);
        } else {
          service();
        }
      }
    }
    if (performance.now() >= deadline) {
      throw lockFailure;
    }
  }
}
