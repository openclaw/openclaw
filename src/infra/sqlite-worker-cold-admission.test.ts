import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import { withStateDatabaseColdAdmission } from "./gateway-state-owner.js";
import { exchangeSqliteDatabaseAdmissions } from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  requestSqliteWorkerSchemaMaintenance,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "./sqlite-worker-operation-settlement.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ["creation", "retry"],
  ["creation", "exhausted"],
  ["creation", "non-open"],
  ["creation", "companion"],
  ["creation", "revoked"],
  ["schema", "retry"],
  ["schema", "exhausted"],
  ["schema", "non-open"],
  ["schema", "companion"],
  ["schema", "revoked"],
  ["schema", "lease-held"],
  ["schema", "acquire-pending"],
  ["schema", "transaction"],
] as const)("keeps cold %s admission bounded and authoritative: %s", (transport, scenario) => {
  const root = tempDirs.make("sqlite-cold-admission-");
  const databasePath = path.join(root, "state.sqlite");
  const requestedPath =
    scenario === "companion" ? path.join(root, "companion.sqlite") : databasePath;
  const pending = new StateDatabaseAdmissionPendingError(databasePath, "Synthetic schema owner");
  const revoked = new Error("Synthetic request revoked");
  let schemaBusy = scenario !== "lease-held";
  let requestCurrent = true;
  const mutate = vi.fn();
  const create = vi.fn();
  const release = vi.fn();
  const admission = createSqliteWorkerOperationAdmission(() => {
    throw new Error("Cold file creation must not enter a transaction");
  });
  admission.bindDatabaseAuthority({
    databasePath: resolveIdentityPathViaExistingAncestorSync(databasePath),
    coldOpenPath: scenario === "non-open" ? undefined : databasePath,
    assertRequest() {
      if (!requestCurrent) {
        throw revoked;
      }
    },
    assertAccess() {
      if (schemaBusy && scenario !== "acquire-pending") {
        throw pending;
      }
    },
    assertCreate: create,
    acquireSchema() {
      if (transport === "creation") {
        throw new Error("File creation must not borrow schema authority");
      }
      if (schemaBusy) {
        throw pending;
      }
      return { assertCurrent() {}, release };
    },
  });
  // Service the real port exchange and release the foreign schema holder only
  // when the existing cold-admission owner yields, without sleeps or polling.
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    if (timeout === undefined) {
      admission.service();
    } else {
      expect(existsSync(requestedPath)).toBe(false);
      expect(mutate).not.toHaveBeenCalled();
      schemaBusy = false;
      requestCurrent = scenario !== "revoked";
    }
    return "ok";
  });
  const owner: SqliteWorkerOperationContext = { port: admission.port };
  const open = () =>
    withSqliteWorkerOperationAdmission(owner, () => {
      if (scenario === "lease-held") {
        requestSqliteWorkerSchemaMaintenance(databasePath);
        schemaBusy = true;
      }
      return withStateDatabaseColdAdmission(
        { databasePath: requestedPath, busyTimeoutMs: scenario === "exhausted" ? 0 : 100 },
        () => {
          if (transport === "creation") {
            exchangeSqliteDatabaseAdmissions(admission.port, [], requestedPath, true);
          } else if (scenario === "transaction") {
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          } else {
            requestSqliteWorkerSchemaMaintenance(requestedPath);
          }
          mutate();
        },
      );
    });
  const succeeds = scenario === "retry" || scenario === "acquire-pending";
  const retryable = succeeds || scenario === "exhausted";
  try {
    if (succeeds) {
      expect(open).not.toThrow();
      expect(mutate).toHaveBeenCalledOnce();
      if (transport === "creation") {
        expect(create).toHaveBeenCalledExactlyOnceWith(databasePath);
        expect(existsSync(databasePath)).toBe(true);
      } else {
        expect(create).not.toHaveBeenCalled();
        expect(existsSync(databasePath)).toBe(false);
      }
    } else {
      if (scenario === "exhausted") {
        expect(open).toThrow(StateDatabaseAdmissionPendingError);
      } else {
        expect(open).toThrow(
          transport === "creation"
            ? "SQLite admission facts exchange failed"
            : "SQLite transaction admission was refused",
        );
      }
      expect(mutate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(existsSync(requestedPath)).toBe(false);
    }
    if (retryable) {
      expect(admission.failure).toBeUndefined();
      expect(owner.refusal).toBeUndefined();
    } else {
      expect(admission.failure).toBe(scenario === "revoked" ? revoked : pending);
      if (transport === "schema") {
        expect(owner.refusal).toBeInstanceOf(Error);
      }
    }
    expect(release).not.toHaveBeenCalled();
  } finally {
    admission.finish();
  }
  expect(release).toHaveBeenCalledTimes(
    transport === "schema" && (succeeds || scenario === "lease-held") ? 1 : 0,
  );
});
