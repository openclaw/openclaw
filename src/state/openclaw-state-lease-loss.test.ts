import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createUpdateErrorFact } from "../infra/update-failure-facts.js";
import { updateRunFixture } from "../infra/update-run-fixture.test-support.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  renewOpenClawStateLease,
  verifyOpenClawStateLeaseOwnership,
} from "./openclaw-state-lease-storage.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const now = 1_800_000_000_000;
const identity = { scope: "synthetic", key: "diagnostics", owner: "private-original-token" };
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { operation: "renew", reason: "expired" },
  { operation: "renew", reason: "replaced" },
  { operation: "renew", reason: "missing" },
  { operation: "verify", reason: "expired" },
  { operation: "verify", reason: "replaced" },
  { operation: "verify", reason: "missing" },
] as const)(
  "retains $reason loss through $operation and update history",
  ({ operation, reason }) => {
    const env = {
      HOME: dirs.make("lease-loss-"),
      OPENCLAW_STATE_DIR: dirs.make("lease-loss-state-"),
    };
    const options = { env };
    const { db } = openOpenClawStateDatabase(options);
    const sql = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
    const params = {
      ...identity,
      database: { scope: "shared" as const, options },
      operationLabel: "state.lease",
      leaseLabel: "state lease",
      leaseMs: 5_000,
    };
    vi.spyOn(Date, "now").mockReturnValue(now);
    acquireOpenClawStateLeaseInTransaction(db, identity, 5_000);
    if (reason === "missing") {
      executeSqliteQuerySync(db, sql.deleteFrom("state_leases"));
    } else {
      executeSqliteQuerySync(
        db,
        sql
          .updateTable("state_leases")
          .set(
            reason === "expired"
              ? { expires_at: now - 1_000, heartbeat_at: now - 6_000 }
              : { owner: "private-replacement-token" },
          ),
      );
    }
    let lost: unknown;
    try {
      if (operation === "renew") {
        renewOpenClawStateLease(params);
      } else {
        verifyOpenClawStateLeaseOwnership(params);
      }
    } catch (error) {
      lost = error;
    }
    const loss =
      reason === "expired"
        ? { reason, expiresAt: now - 1_000, expiredByMs: 1_000, heartbeatAgeMs: 6_000 }
        : reason === "replaced"
          ? { reason, owner: "[redacted]" }
          : { reason };
    expect(lost).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST", loss });
    const transported = new Error("worker envelope");
    retainOpenClawStateWorkerErrorPayload(transported, encodeOpenClawStateWorkerError(lost));
    const hydrated = hydrateOpenClawStateWorkerError(transported);
    expect(hydrated).toMatchObject({ loss });
    expect(createUpdateErrorFact("plugin-finalization", hydrated, env).code).toBe(
      "OPENCLAW_STATE_LEASE_LOST",
    );
    const fact = createUpdateErrorFact(
      "plugin-finalization",
      new Error("x".repeat(400), { cause: hydrated }),
      env,
    );
    const run = updateRunFixture(options);
    run.step({ step: "plugin-finalization", status: "failed", failureFacts: [fact] });
    run.finish({ status: "failed", reason: "plugin-finalization-failed" });
    const record = run.read();
    expect(
      record?.steps.find((step) => step.step === "plugin-finalization")?.failureFacts?.[0],
    ).toMatchObject({ leaseLoss: loss });
    const report = renderUpdateRunReport(record!);
    expect(report.markdown).toContain(`lease loss: ${reason}`);
    expect(JSON.stringify({ record, report, lost, hydrated })).not.toContain(
      "private-original-token",
    );
    expect(JSON.stringify({ record, report, lost, hydrated })).not.toContain(
      "private-replacement-token",
    );
    executeSqliteQuerySync(db, sql.deleteFrom("state_leases"));
  },
);

it("preserves the generic loss when the diagnostic row cannot be read", () => {
  using db = openNodeSqliteDatabase(":memory:");
  db.exec("CREATE TABLE state_leases (scope TEXT, lease_key TEXT, owner TEXT, expires_at INTEGER)");
  expect(() =>
    verifyOpenClawStateLeaseOwnership({ ...identity, leaseLabel: "state lease", transaction: db }),
  ).toThrowError(
    expect.objectContaining({
      code: "OPENCLAW_STATE_LEASE_LOST",
      message: "state lease synthetic/diagnostics was lost",
    }),
  );
});
