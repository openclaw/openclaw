import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import {
  takeSqliteWorkerOperationAdmissionAttachment,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import type { WorkerLeaseScope } from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return { outcome, settled: () => settled };
}

export function waitUntil<T>(entered: Promise<T>, result: ReturnType<typeof observe>) {
  return Promise.race([
    entered,
    result.outcome.then((outcome) => {
      throw outcome.ok ? new Error("Lease completed before callback/startup") : outcome.error;
    }),
  ]);
}

export function leaseTestContext() {
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const databasePath = "/synthetic-state/lease.sqlite";
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic-state" },
    maintenanceScope: maintenance,
    admission: {
      coordinationKey: "file:synthetic-state",
      databasePath,
      identity: { key: "file:synthetic-state", canonicalPath: databasePath },
      assertCurrent() {
        expect(getOpenClawDatabaseMaintenanceScope()).toBe(maintenance);
      },
    },
  };
  return { maintenance, context };
}

export function expiryAdmission(scope: WorkerLeaseScope) {
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  const { admission } = scope.createAdmission({ settled: settled.promise });
  try {
    const attachment = withSqliteWorkerOperationAdmission(
      admission,
      takeSqliteWorkerOperationAdmissionAttachment,
    );
    if (
      !isRecord(attachment) ||
      attachment.kind !== "state-lease-expiry" ||
      !(attachment.observation instanceof SharedArrayBuffer)
    ) {
      throw new Error("Missing owner-bound expiry observation");
    }
    expect(attachment.identity).toEqual(scope.identity);
    const observation = new BigInt64Array(attachment.observation);
    return {
      publish(expiresAt: number) {
        Atomics.store(observation, leaseHeartbeatState.expiresAt, BigInt(expiresAt));
        return expiresAt;
      },
      [Symbol.dispose]() {
        admission.finish();
        settled.resolve({ kind: "completed" });
      },
    };
  } catch (error) {
    admission.finish();
    settled.resolve({ kind: "completed" });
    throw error;
  }
}
