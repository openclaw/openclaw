import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeDatabasePath } from "./sqlite-worker-identity.js";

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
  const canonical = location === null ? null : normalizeDatabasePath(location);
  writeAdmissionLocations.set(database, canonical);
  return canonical;
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
  const locations = new Set(nativeLocations.map(normalizeDatabasePath));
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

/** Both engines use the native anchor identity for host-dependent commit grants. */
export function readSqliteWriteAdmissionServices(
  database: DatabaseSync,
): ReadonlySet<() => void> | undefined {
  const location = writeAdmissionServices.size > 0 ? writeAdmissionLocation(database) : null;
  return location === null ? undefined : writeAdmissionServices.get(location);
}
