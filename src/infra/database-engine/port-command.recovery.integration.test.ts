import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import * as recovery from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as sourceSnapshots from "../sqlite-snapshot-source.js";
import * as snapshots from "../sqlite-snapshot.js";
import * as fixtures from "./port-command.integration.test-support.js";
import * as tasks from "./port-command.worker.js";

describe.skipIf(!fixtures.connection)("database port command PostgreSQL conformance", () => {
  it("round-trips canonical cells, IDs, cursors and allocation facts through the command", async () => {
    await fixtures.fixture(
      async ({ state, source, client }) => {
        assert(client);
        const before = fixtures.canonical(source);
        const query = async (sql: string) => (await client.query(sql)).rows;
        const privateSources = new Set<string>();
        const isolatedReads = vi.spyOn(sourceSnapshots, "prepareSqliteReadOnlyLocationSync");
        const isolatedCopies = vi.spyOn(sourceSnapshots, "prepareSqliteReadOnlyLocation");
        const run = tasks.runDatabasePortTask;
        vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
          if (args[0].operation === "migrate" || args[0].operation === "stage") {
            privateSources.add(args[0].sourcePath);
          }
          return run(...args);
        });
        const include = fs.readFileSync(state.statePath("plugins.json"), "utf8");
        const forward = await doctorDatabasePort({ to: "postgres" });
        const sharedPath = state.statePath("state", "openclaw.sqlite");
        const sharedAnchor = readBackupEngine(sharedPath);
        assert(sharedAnchor.engine === "postgres");
        expect(
          await query(
            `SELECT value_json FROM "${sharedAnchor.namespace}".config_machine_state WHERE state_key = 'config.lastTouchedAt'`,
          ),
        ).toEqual([{ value_json: expect.any(String) }]);
        const anchor = readBackupEngine(source);
        assert(anchor.engine === "postgres");
        expect(
          await query(`SELECT sequence FROM "${anchor.namespace}".workboard_card_notifications`),
        ).toEqual([{ sequence: "9007199254740995" }]);
        const reverse = await doctorDatabasePort({ to: "sqlite" });
        expect(readBackupEngine(sharedPath)).toEqual({ engine: "sqlite" });
        {
          using shared = openNodeSqliteDatabase(sharedPath, { readOnly: true });
          expect(
            shared
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key = 'config.lastTouchedAt'",
              )
              .get(),
          ).toEqual({ value_json: expect.any(String) });
        }
        expect(fixtures.canonical(source)).toEqual(before);
        expect(privateSources.size).toBeGreaterThan(0);
        expect(
          [...isolatedReads.mock.calls, ...isolatedCopies.mock.calls].filter(([file]) =>
            privateSources.has(file),
          ),
        ).toEqual([]);
        expect(readBackupEngine(source)).toEqual({ engine: "sqlite" });
        expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject(
          fixtures.portConfig,
        );
        expect(fs.readFileSync(state.statePath("plugins.json"), "utf8")).toBe(include);
        assert("manifest" in forward && typeof forward.manifest === "string");
        await expect(doctorDatabasePort({ rollback: forward.manifest })).rejects.toThrow(
          "Database port",
        );
        expect(fixtures.canonical(source)).toEqual(before);
        const output = JSON.stringify({ forward, reverse });
        expect(output).not.toContain(fixtures.connection);
        expect(output).not.toContain(fixtures.payload);
        expect(output).not.toContain("synthetic-port-secret");
      },
      true,
      1001,
    );
  }, 120_000);

  it.each([
    "capture",
    "migrate",
    "stage",
    "verify",
    "replacement",
    "config",
    "config committed",
    "initial manifest",
    "preparing revision",
    "publishing revision",
    "complete revision",
  ])(
    "retains originals and recovers after a %s failure",
    async (point) => {
      await fixtures.fixture(async ({ state, source }) => {
        const before = fixtures.canonical(source);
        const originalConfig = fs.readFileSync(state.configPath, "utf8");
        let fired = false;
        const fail = () => {
          fired = true;
          throw new Error(fixtures.injected);
        };
        const published = ["config", "config committed", "complete revision"].includes(point);
        if (["migrate", "stage", "verify"].includes(point)) {
          const run = tasks.runDatabasePortTask;
          vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
            if (!fired && args[0].operation === point) {
              fail();
            }
            return await run(...args);
          });
        } else if (point === "capture") {
          vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementationOnce(async () =>
            fail(),
          );
        } else if (point === "replacement") {
          const prepare = snapshots.prepareVerifiedSqliteFile;
          vi.spyOn(snapshots, "prepareVerifiedSqliteFile").mockImplementation(async (...args) => {
            const prepared = await prepare(...args);
            return { ...prepared, publish: async () => fail() };
          });
        } else if (point === "config" || point === "config committed") {
          const write = configIo.writeConfigFile;
          vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
            if (point === "config committed") {
              await write(...args);
            }
            return fail();
          });
        } else {
          const write = recovery.writeDatabasePortManifest;
          vi.spyOn(recovery, "writeDatabasePortManifest").mockImplementation((...args) => {
            const value = args[1];
            const matches =
              point === "initial manifest"
                ? value.revision === 1
                : point === "preparing revision"
                  ? value.state === "preparing" && value.revision > 1
                  : point === `${value.state} revision`;
            if (!fired && matches) {
              fail();
            }
            return write(...args);
          });
        }
        const error = await doctorDatabasePort({ to: "postgres" }).catch(
          (failure: unknown) => failure,
        );
        expect(fired).toBe(true);
        fixtures.expectSafe(
          error,
          published
            ? state.stateDir
            : point === "initial manifest"
              ? state.statePath("state", "openclaw.sqlite")
              : source,
          point === "capture" ? "capture originals" : "Database port",
        );
        vi.restoreAllMocks();
        const active = recovery.databasePortManifestPath(state.stateDir);
        if (fs.existsSync(active)) {
          const target = fixtures.manifest(state).targets[0];
          assert(target);
          expect(fixtures.canonical(target.originalCapture.path)).toEqual(before);
          if (!published) {
            expect(fixtures.canonical(source)).toEqual(before);
            expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
          }
          const rollback = ["config", "complete revision"].includes(point);
          await doctorDatabasePort(rollback ? { rollback: active } : { resume: active });
          expect(fs.existsSync(active)).toBe(false);
          if (!rollback) {
            await doctorDatabasePort({ to: "sqlite" });
          }
        } else {
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
        }
        expect(fixtures.canonical(source)).toEqual(before);
      }, true);
    },
    120_000,
  );
});
