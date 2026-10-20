import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { readUserBackgroundCommand } from "../../state/user-background.kernel.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { runSqliteReadSnapshotSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(!connection)(
  "reads backgrounds while a writer holds the store lock and joins enclosing snapshots",
  async () => {
    const directory = tempDirs.make("state-read-lock-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_read_lock" },
    });
    const blocker = new pg.Client({ connectionString: connection });
    await blocker.connect();
    let namespace: string | undefined;
    try {
      const { database, first, second, facts } = withEngineStoreAdmission(() => {
        const firstProfile = ensureProfileForEmail("first@example.test", options);
        const secondProfile = ensureProfileForEmail("second@example.test", options);
        const opened = openOpenClawStateDatabase(options);
        const physical = getPostgresPhysicalFacts(opened.db);
        assert(physical, "Expected PostgreSQL state admission");
        opened.db.exec("SET lock_timeout = '100ms'");
        return { database: opened, first: firstProfile, second: secondProfile, facts: physical };
      });
      namespace = facts.namespace;
      const read = () => {
        const reply = readUserBackgroundCommand(database.db, {
          type: "userBackground.snapshot",
          profileId: first.id,
        });
        assert(reply.type === "userBackground.snapshot", "Expected background snapshot");
        return reply;
      };
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        createHash("sha256").update(facts.storeId).digest().readBigInt64BE().toString(),
      ]);
      expect(withEngineStoreAdmission(read)).toEqual({
        type: "userBackground.snapshot",
        profileId: first.id,
        result: { status: "ok", asset: null, preference: null },
      });
      await blocker.query("ROLLBACK");

      withEngineStoreAdmission(() => {
        runSqliteReadSnapshotSync(database.db, () => {
          expect(read().profileId).toBe(first.id);
          expect(database.db.isTransaction).toBe(true);
          expect(
            database.db.prepare("SHOW transaction_read_only").get()?.transaction_read_only,
          ).toBe("on");
        });
        expect(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run(
                second.id,
                first.id,
              );
              expect(read().profileId).toBe(second.id);
              expect(db.isTransaction).toBe(true);
              throw new Error("rollback enclosing write");
            },
            { database },
          ),
        ).toThrow("rollback enclosing write");
        expect(read().profileId).toBe(first.id);
      });
    } finally {
      await blocker.query("ROLLBACK");
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await blocker.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await blocker.end();
      }
    }
  },
);
