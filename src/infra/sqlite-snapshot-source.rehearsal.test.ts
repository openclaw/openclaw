import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import * as reads from "../state/artifact-preserving-state-reads.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import * as state from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  openSqliteReadOnlyDatabase,
  prepareArtifactPreservingSqliteRead,
} from "./sqlite-snapshot-source.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["drained", "wal", "wal-symlink", "journal", "journal-symlink", "unowned"])(
  "prepares an in-place inspection only with maintenance custody (%s)",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("sqlite-custodied-read-"));
    const file = path.join(root, "agent.sqlite");
    exec(file, "CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)");
    if (kind.startsWith("wal")) {
      const source = path.join(root, "wal-source.sqlite");
      using db = openNodeSqliteDatabase(source);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (42)");
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.copyFileSync(source + suffix, file + suffix);
      }
    }
    if (kind.startsWith("journal")) {
      fs.writeFileSync(`${file}-journal`, Buffer.alloc(512));
    }
    const requested = kind.endsWith("-symlink") ? path.join(root, "linked.sqlite") : file;
    if (requested !== file) {
      fs.symlinkSync(file, requested);
    }
    const before = fs.readFileSync(file);
    const entries = fs
      .readdirSync(root)
      .filter((name) => name.startsWith("agent.sqlite"))
      .toSorted();
    const inspect = () =>
      reads.withArtifactPreservingStateReads(
        async () => {
          await prepareArtifactPreservingSqliteRead(requested);
          using db = openSqliteReadOnlyDatabase(requested);
          expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: 42 });
          expect(db.location() === file).toBe(kind === "drained");
          expect(() => db.exec("UPDATE probe SET value = 99")).toThrow(/readonly/);
        },
        { agentDatabases: true },
      );
    if (kind === "unowned") {
      await inspect();
    } else {
      await withDoctorSqliteMaintenanceLock({
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        operation: "synthetic stopped inspection",
        run: async (authority) => {
          const scope = createOpenClawDatabaseMaintenanceScope({
            schemaMaintenance: true,
            assertOwnerCurrent: () => authority.assertCurrent(),
            assertDatabaseAccess: () => authority.assertCurrent(),
          });
          try {
            await scope.run(inspect);
          } finally {
            await scope.close();
          }
        },
      });
    }
    expect(fs.readFileSync(file)).toEqual(before);
    expect(
      fs
        .readdirSync(root)
        .filter((name) => name.startsWith("agent.sqlite"))
        .toSorted(),
    ).toEqual(entries);
  },
);

function rehearsalEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}

function exec(file: string, sql: string) {
  using database = openNodeSqliteDatabase(file);
  database.exec(sql);
}

it.each(["prepared", "outside", "symlink", "sidecar-symlink", "incomplete", "shared"])(
  "reuses only prepared rehearsal bytes across checks (%s)",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("sqlite-rehearsal-read-"));
    const outside = fs.realpathSync(dirs.make("sqlite-rehearsal-outside-"));
    const env = rehearsalEnv(root);
    if (kind === "incomplete") {
      env.OPENCLAW_SKIP_CHANNELS = undefined;
    }
    const file =
      kind === "shared"
        ? path.join(root, "state", "openclaw.sqlite")
        : path.join(kind === "outside" || kind === "symlink" ? outside : root, "agent.sqlite");
    const options = { env, path: file };
    const seed = "CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)";
    if (kind === "shared") {
      state.openOpenClawStateDatabase(options).db.exec(seed);
      await closeOpenClawStateDatabaseAsync();
    } else {
      exec(file, seed);
    }
    const source = kind === "symlink" ? path.join(root, "linked.sqlite") : file;
    if (kind === "symlink") {
      fs.symlinkSync(file, source);
    }
    if (kind === "sidecar-symlink") {
      const sidecar = path.join(outside, "source-shm");
      fs.writeFileSync(sidecar, "");
      fs.symlinkSync(sidecar, `${source}-shm`);
    }
    await withEnvAsync(env, async () => {
      for (const value of [1, 2]) {
        let reader: ReturnType<typeof openSqliteReadOnlyDatabase> | undefined;
        reads.withArtifactPreservingStateReads(
          () => {
            if (kind === "shared") {
              withOpenClawStateDatabaseReadOnly(({ db }) => {
                expect(requireNativeSqliteDatabase(db).location()).toBe(file);
                expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value });
              }, options);
              expect(() => state.runOpenClawStateWriteTransaction(() => {}, options)).toThrow(
                "shared-state write during artifact-preserving inspection",
              );
              return;
            }
            reader = openSqliteReadOnlyDatabase(source, { readOnly: false });
            expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value });
            expect(reader.location() === source).toBe(kind === "prepared");
            expect(reads.isArtifactPreservingStateRead("agent", source)).toBe(true);
            expect(() => reader!.exec("UPDATE probe SET value = 99")).toThrow(/readonly/);
          },
          { agentDatabases: true },
        );
        if (kind !== "shared") {
          expect(reader?.isOpen).toBe(false);
        }
        exec(file, "UPDATE probe SET value = 2");
      }
    });
  },
);
