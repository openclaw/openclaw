import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  doctorDatabasePort,
  type DatabasePortOptions,
} from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  assertDatabasePortStartupAllowed,
  databasePortManifestPath,
  type DatabasePortManifest,
} from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { canonical, connection, files } from "./port-command.integration.test-support.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

// Reuse one installation and server connection across both family and recovery directions.
describe.skipIf(!connection)("family-scoped database port", () => {
  let state: OpenClawTestState;
  let client: Client;
  let workboard: string;
  let shared: string;
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const config = () => JSON.parse(fs.readFileSync(state.configPath, "utf8")) as OpenClawConfig;
  const port = (options: DatabasePortOptions) => doctorDatabasePort(options);

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", prefix: "mixed-port-" });
    await state.writeConfig({
      database: {
        engine: "sqlite",
        postgres: { connection: connection! },
      },
      plugins: { entries: { workboard: { enabled: false } } },
    });
    workboard = state.statePath("plugins", "workboard", "workboard.sqlite");
    shared = state.statePath("state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(workboard), { recursive: true });
    {
      using db = openNodeSqliteDatabase(workboard);
      db.exec(metadata.sqlite);
      db.exec(
        "INSERT INTO workboard_schema_migrations VALUES ('schema-3', 17); INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('mixed-board', 'retained board', 1, 2)",
      );
    }
    client = new Client({ connectionString: connection });
    await client.connect();
    await port({ family: "state", to: "postgres" });
    await port({ family: "state", to: "sqlite" });
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (state && client) {
      const namespaces = new Set<string>();
      const directory = state.statePath("recovery", "database-port");
      for (const file of await files(directory)) {
        if (
          path.basename(file) !== "manifest.json" ||
          path.dirname(path.dirname(file)) !== directory
        ) {
          continue;
        }
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as DatabasePortManifest;
        for (const target of saved.targets) {
          for (const location of [target.original, target.intended]) {
            if (location.engine === "postgres") {
              namespaces.add(location.namespace);
            }
          }
        }
      }
      for (const namespace of namespaces) {
        assert.match(namespace, /^(port|restore)_[a-f0-9]+$/);
        await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      }
    }
    await client?.end();
    await state?.cleanup();
  });

  it.each(["state", "workboard"] as const)(
    "round-trips %s with an unrelated PostgreSQL family",
    async (family) => {
      const other = family === "state" ? "workboard" : "state";
      const otherPath = family === "state" ? workboard : shared;
      const selectedPath = family === "state" ? shared : workboard;
      const before = canonical(workboard);
      await port({ family: other, to: "postgres" });
      const untouched = hash(otherPath);
      await expect(port({ to: "postgres" })).rejects.toThrow("requires --family");
      const result = await port({ family, to: "postgres" });
      expect(result.stores).toEqual([selectedPath]);
      expect(hash(otherPath)).toBe(untouched);
      expect(config().database).toMatchObject({
        engine: "sqlite",
        families: {
          [family]: { engine: "postgres" },
          [other]: { engine: "postgres" },
        },
      });
      await port({ family, to: "sqlite" });
      expect(hash(otherPath)).toBe(untouched);
      expect(readBackupEngine(selectedPath).engine).toBe("sqlite");
      expect(config().database?.families).toEqual({ [other]: { engine: "postgres" } });
      await port({ family: other, to: "sqlite" });
      expect(config().database?.families).toBeUndefined();
      expect(canonical(workboard)).toEqual(before);
    },
    120_000,
  );

  it("refuses agents on a different engine from state before any publication", async () => {
    const before = fs.readFileSync(state.configPath);
    await expect(port({ family: "agent", to: "postgres" })).rejects.toThrow(
      /different engine than state until PR3/,
    );
    expect(fs.readFileSync(state.configPath)).toEqual(before);
  });

  describe("interrupted scoped publication", () => {
    beforeAll(async () => {
      await port({ family: "state", to: "postgres" });
    }, 120_000);
    afterAll(async () => {
      await port({ family: "state", to: "sqlite" });
    }, 120_000);

    it.each(["resume", "rollback"] as const)(
      "blocks startup and supports %s",
      async (action) => {
        const other = hash(shared);
        const before = canonical(workboard);
        const write = configIo.writeConfigFile;
        vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error("synthetic interruption after publication");
        });
        await expect(port({ family: "workboard", to: "postgres" })).rejects.toThrow(
          "Database port",
        );
        vi.restoreAllMocks();
        expect(readBackupEngine(workboard).engine).toBe("postgres");
        expect(() => assertDatabasePortStartupAllowed(state.stateDir)).toThrow();
        const active = databasePortManifestPath(state.stateDir);
        const saved = JSON.parse(fs.readFileSync(active, "utf8")) as DatabasePortManifest;
        const inputsFile = saved.artifacts.find(
          (file) => path.basename(file.path) === "inputs.json",
        );
        assert(inputsFile);
        expect(JSON.parse(fs.readFileSync(inputsFile.path, "utf8"))).toMatchObject({
          selection: {
            path: ["database", "families", "workboard", "engine"],
            originalValue: null,
            effectiveSource: "sqlite",
          },
        });
        await port({ [action]: active });
        expect(() => assertDatabasePortStartupAllowed(state.stateDir)).not.toThrow();
        expect(hash(shared)).toBe(other);
        expect(readBackupEngine(workboard).engine).toBe(
          action === "resume" ? "postgres" : "sqlite",
        );
        if (action === "resume") {
          await port({ family: "workboard", to: "sqlite" });
        }
        expect(canonical(workboard)).toEqual(before);
      },
      120_000,
    );
  });
});
