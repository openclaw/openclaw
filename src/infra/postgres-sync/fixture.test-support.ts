import { DatabaseSync } from "node:sqlite";
import { afterEach, vi } from "vitest";
import { createSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import { PostgresSyncConnection } from "./connection.js";

export function usePostgresFixture() {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    vi.restoreAllMocks();
  });
  function nativeDatabase() {
    const db = new DatabaseSync(":memory:");
    cleanups.push(() => db.close());
    return db;
  }
  return {
    cleanups,
    nativeDatabase,
    connection() {
      // Exercise the real connection methods without starting a bridge.
      const db = Object.create(PostgresSyncConnection.prototype) as PostgresSyncConnection;
      Object.defineProperties(db, {
        [Symbol.for("openclaw.postgres-sync-connection")]: { value: true },
        anchor: { value: nativeDatabase() },
        advisoryLockKey: { value: -42n },
      });
      return Object.assign(db, { isOpen: true, isTransaction: false, mutationRevision: 0 });
    },
    admission(...args: Parameters<typeof createSqliteWorkerOperationAdmission>) {
      const admission = createSqliteWorkerOperationAdmission(...args);
      cleanups.push(() => admission.finish());
      return admission;
    },
  };
}
