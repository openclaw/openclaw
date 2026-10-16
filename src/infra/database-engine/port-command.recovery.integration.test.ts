import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import * as recovery from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as snapshots from "../sqlite-snapshot.js";
import {
  canonical,
  connection,
  credentialRef,
  expectSafe,
  fixture,
  injected,
  manifest,
  payload,
} from "./port-command.integration.test-support.js";
import * as tasks from "./port-command.worker.js";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!connection)("database port command PostgreSQL conformance", () => {
  it("round-trips canonical cells, IDs, cursors and allocation facts through the command", async () => {
    await fixture(
      async ({ state, source, client }) => {
        assert(client);
        const before = canonical(source);
        const include = fs.readFileSync(state.statePath("plugins.json"), "utf8");
        const forward = await doctorDatabasePort({ to: "postgres" });
        const sharedPath = state.statePath("state", "openclaw.sqlite");
        const sharedAnchor = readBackupEngine(sharedPath);
        assert(sharedAnchor.engine === "postgres");
        expect(
          (
            await client.query(
              `SELECT value_json FROM "${sharedAnchor.namespace}".config_machine_state WHERE state_key = 'config.lastTouchedAt'`,
            )
          ).rows,
        ).toEqual([{ value_json: expect.any(String) }]);
        const anchor = readBackupEngine(source);
        assert(anchor.engine === "postgres");
        expect(
          (
            await client.query(
              `SELECT sequence FROM "${anchor.namespace}".workboard_card_notifications`,
            )
          ).rows,
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
        expect(canonical(source)).toEqual(before);
        expect(readBackupEngine(source)).toEqual({ engine: "sqlite" });
        const authored = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        expect(authored).toMatchObject({
          plugins: { $include: "plugins.json" },
          gateway: { auth: { mode: "token", token: credentialRef } },
          database: {
            engine: "sqlite",
            postgres: { connection: "${OPENCLAW_P36_TEST_DATABASE_URL}" },
          },
        });
        expect(fs.readFileSync(state.statePath("plugins.json"), "utf8")).toBe(include);
        assert("manifest" in forward && typeof forward.manifest === "string");
        await expect(doctorDatabasePort({ rollback: forward.manifest })).rejects.toThrow(
          "Database port",
        );
        expect(canonical(source)).toEqual(before);
        const output = JSON.stringify({ forward, reverse });
        expect(output).not.toContain(connection);
        expect(output).not.toContain(payload);
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
      await fixture(async ({ state, source }) => {
        const before = canonical(source);
        const originalConfig = fs.readFileSync(state.configPath, "utf8");
        let fired = false;
        const fail = () => {
          fired = true;
          throw new Error(injected);
        };
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
            if (
              !fired &&
              ((point === "initial manifest" && value.revision === 1) ||
                (point === "preparing revision" &&
                  value.state === "preparing" &&
                  value.revision > 1) ||
                (point === "publishing revision" && value.state === "publishing") ||
                (point === "complete revision" && value.state === "complete"))
            ) {
              fail();
            }
            return write(...args);
          });
        }
        const error = await doctorDatabasePort({ to: "postgres" }).catch(
          (failure: unknown) => failure,
        );
        expect(fired).toBe(true);
        expectSafe(
          error,
          ["config", "config committed", "complete revision"].includes(point)
            ? state.stateDir
            : point === "initial manifest"
              ? state.statePath("state", "openclaw.sqlite")
              : source,
          point === "capture" ? "capture originals" : "Database port",
        );
        vi.restoreAllMocks();
        const active = recovery.databasePortManifestPath(state.stateDir);
        if (fs.existsSync(active)) {
          const saved = manifest(state);
          const target = saved.targets[0];
          assert(target);
          const captured = target.originalCapture.path;
          expect(canonical(captured)).toEqual(before);
          if (!["config", "config committed", "complete revision"].includes(point)) {
            expect(canonical(source)).toEqual(before);
            expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
          }
          const rollback = ["config", "complete revision"].includes(point);
          await doctorDatabasePort(rollback ? { rollback: active } : { resume: active });
          expect(fs.existsSync(active)).toBe(false);
          if (!rollback) {
            await doctorDatabasePort({ to: "sqlite" });
          }
          expect(canonical(source)).toEqual(before);
        } else {
          expect(canonical(source)).toEqual(before);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
        }
      }, true);
    },
    120_000,
  );
});
