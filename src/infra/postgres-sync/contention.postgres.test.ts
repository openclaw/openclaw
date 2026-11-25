import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawStateLeaseCleanup } from "../../state/openclaw-state-lease-cleanup.js";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { isSqliteLockError } from "../sqlite-error-diagnostics.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("contention");
const { connection, prefix: schema, client: admin } = harness;

describe.skipIf(!connection)("PostgreSQL contended lease cleanup", () => {
  it("retries a rolled-back lock timeout and releases the retained lease", async () => {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".leases (owner text);
      INSERT INTO "${schema}".leases VALUES ('original')`);
    const anchor = new DatabaseSync(":memory:");
    const run = withEngineStoreAdmission;
    const db = run(
      () => new PostgresSyncConnection(connection!, schema, anchor, schema, { lockTimeoutMs: 10 }),
    );
    const cleanup = createOpenClawStateLeaseCleanup({
      revoke() {},
      workerOwner: () => undefined,
      retryDeadline: () => Date.now() + 5_000,
      finish: async () => {
        run(() =>
          db.runTransaction(() => db.prepare("DELETE FROM leases WHERE owner = ?").run("original")),
        );
      },
    });
    try {
      await admin.query("BEGIN");
      await admin.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        db.advisoryLockKey.toString(),
      ]);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let failure: unknown;
      try {
        await cleanup.run(
          async () => {},
          () => {},
        );
      } catch (error) {
        failure = error;
      }
      // Read the committed row while the writer lock is still held. The failed
      // transaction must be rolled back before its resource owner can retry.
      expect((await admin.query(`SELECT owner FROM "${schema}".leases`)).rows).toEqual([
        { owner: "original" },
      ]);
      expect(db.isOpen).toBe(true);
      expect(db.isTransaction).toBe(false);
      await admin.query("ROLLBACK");
      await vi.advanceTimersByTimeAsync(250);
      expect(run(() => db.prepare("SELECT owner FROM leases").all())).toEqual([]);
      expect(isSqliteLockError(failure)).toBe(true);
      expect(failure).toMatchObject({ cause: { code: "55P03" } });
    } finally {
      vi.useRealTimers();
      await admin.query("ROLLBACK");
      run(() => db.close());
      anchor.close();
    }
  });
});
