import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import { withStateDatabaseColdAdmission } from "./gateway-state-owner.js";
import { exchangeSqliteDatabaseAdmissions } from "./sqlite-worker-database-admission-relay.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["retry", "exhausted", "non-open", "companion", "revoked"] as const)(
  "keeps cold creation admission bounded and authoritative: %s",
  (scenario) => {
    const root = tempDirs.make("sqlite-cold-admission-");
    const databasePath = path.join(root, "state.sqlite");
    const requestedPath =
      scenario === "companion" ? path.join(root, "companion.sqlite") : databasePath;
    const pending = new StateDatabaseAdmissionPendingError(databasePath, "Synthetic schema owner");
    const revoked = new Error("Synthetic request revoked");
    let schemaBusy = true;
    let requestCurrent = true;
    const mutate = vi.fn();
    const create = vi.fn();
    const admission = createSqliteWorkerOperationAdmission(() => {
      throw new Error("Cold file creation must not enter a transaction");
    });
    admission.bindDatabaseAuthority({
      databasePath,
      coldOpenPath: scenario === "non-open" ? undefined : databasePath,
      assertRequest() {
        if (!requestCurrent) {
          throw revoked;
        }
      },
      assertAccess() {
        if (schemaBusy) {
          throw pending;
        }
      },
      assertCreate: create,
      acquireSchema() {
        throw new Error("File creation must not borrow schema authority");
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
    const open = () =>
      withStateDatabaseColdAdmission(
        { databasePath: requestedPath, busyTimeoutMs: scenario === "exhausted" ? 0 : 100 },
        () => {
          exchangeSqliteDatabaseAdmissions(admission.port, [], requestedPath, true);
          mutate();
        },
      );
    try {
      if (scenario === "retry") {
        expect(open).not.toThrow();
        expect(mutate).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledExactlyOnceWith(databasePath);
        expect(existsSync(databasePath)).toBe(true);
      } else {
        if (scenario === "exhausted") {
          expect(open).toThrow(StateDatabaseAdmissionPendingError);
        } else {
          expect(open).toThrow("SQLite admission facts exchange failed");
        }
        expect(mutate).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(existsSync(requestedPath)).toBe(false);
      }
      if (scenario === "retry" || scenario === "exhausted") {
        expect(admission.failure).toBeUndefined();
      } else {
        expect(admission.failure).toBe(scenario === "revoked" ? revoked : pending);
      }
    } finally {
      admission.finish();
    }
  },
);
