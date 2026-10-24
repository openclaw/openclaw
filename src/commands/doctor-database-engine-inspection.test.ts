import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  listPluginDoctorStateMigrationEntries,
  withDeferredPluginDoctorMigrations,
} from "../plugins/doctor-contract-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  inspectDoctorDatabaseEngines,
  type DoctorDatabaseEngineInspection,
} from "./doctor-database-engine-inspection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let inspection: DoctorDatabaseEngineInspection;
// Missing PostgreSQL connection prevents registry discovery, but cannot hide state evidence.
const config = { database: { engine: "postgres" as const } };

beforeAll(async () => {
  root = tempDirs.make("doctor-engine-inspection-");
  for (const engine of ["sqlite", "postgres"] as const) {
    const directory = path.join(root, ...(engine === "postgres" ? ["voice-calls"] : []), "state");
    fs.mkdirSync(directory, { recursive: true });
    using db = openNodeSqliteDatabase(path.join(directory, "openclaw.sqlite"));
    if (engine === "postgres") {
      db.exec(
        "CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT); INSERT INTO openclaw_engine_anchor VALUES ('fixture-store', 'postgres', 'fixture_namespace')",
      );
    } else {
      db.exec("CREATE TABLE fixture(value TEXT)");
    }
  }
  inspection = await inspectDoctorDatabaseEngines({
    config,
    stateDir: root,
    env: { OPENCLAW_STATE_DIR: root },
  });
});

describe("Doctor physical engine inspection", () => {
  it("reuses loaded migration contracts while inspecting disabled owners' retained data", async () => {
    const stateDir = tempDirs.make("doctor-engine-contract-work-");
    const loads = path.join(stateDir, "contract-loads.txt");
    const plugins = ["retained", "absent-one", "absent-two"].map((id) => {
      const rootDir = path.join(stateDir, "extensions", id);
      fs.mkdirSync(rootDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, "index.js"), "module.exports = {};\n");
      fs.writeFileSync(
        path.join(rootDir, "package.json"),
        JSON.stringify({ name: id, openclaw: { extensions: ["./index.js"] } }),
      );
      fs.writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          configSchema: { type: "object", properties: {} },
          doctorContract: { stateMigrations: [{ id: "legacy" }] },
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "doctor-contract-api.cjs"),
        `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(loads)}, ${JSON.stringify(`${id}\n`)});
exports.stateMigrations = [{
  id: 'legacy', label: 'Retained fixture', sqliteOnly: { family: 'state' },
  detectLegacyState: ({ stateDir }) => fs.existsSync(require('node:path').join(stateDir, ${JSON.stringify(`${id}.legacy`)})) ? { preview: ['Retained fixture'] } : null,
  migrateLegacyState: () => { throw new Error('Inspection must not migrate'); },
}];\n`,
      );
      return id;
    });
    fs.writeFileSync(path.join(stateDir, "retained.legacy"), "retained user data");
    const pluginConfig = {
      plugins: {
        entries: Object.fromEntries(plugins.map((id) => [id, { enabled: id !== "retained" }])),
      },
    };
    const env = {
      HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const cache = createPluginCache();
    try {
      await withPluginCache(cache, async () => {
        // Repair loads enabled owners; diagnostics must additionally inspect disabled owners.
        expect(listPluginDoctorStateMigrationEntries({ config: pluginConfig, env })).toHaveLength(
          2,
        );
        expect(fs.readFileSync(loads, "utf8").trim().split("\n").toSorted()).toEqual([
          "absent-one",
          "absent-two",
        ]);
        const inspect = () =>
          withDeferredPluginDoctorMigrations(["retained"], () =>
            inspectDoctorDatabaseEngines({ config: pluginConfig, env, stateDir }),
          );
        const result = await inspect();
        expect(result.stores?.find((store) => store.family === "state")?.legacyMigrations).toEqual({
          state: "pending",
          pending: ["retained/legacy (Retained fixture)"],
        });
        expect(fs.readFileSync(path.join(stateDir, "retained.legacy"), "utf8")).toBe(
          "retained user data",
        );
        expect(fs.readFileSync(loads, "utf8").trim().split("\n").toSorted()).toEqual(
          plugins.toSorted(),
        );
        fs.unlinkSync(path.join(stateDir, "retained.legacy"));
        const repaired = await inspect();
        expect(
          repaired.stores?.find((store) => store.family === "state")?.legacyMigrations,
        ).toEqual({
          state: "none",
          pending: [],
        });
        expect(fs.readFileSync(loads, "utf8").trim().split("\n").toSorted()).toEqual(
          plugins.toSorted(),
        );
      });
    } finally {
      await retirePluginCache(cache);
    }
  });

  it("does not require optional plugin port descriptors when their stores are absent", async () => {
    const stateDir = tempDirs.make("doctor-engine-absent-stores-");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    try {
      const absent = await inspectDoctorDatabaseEngines({
        config: {},
        stateDir,
        env: {
          OPENCLAW_STATE_DIR: stateDir,
          HOME: stateDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      expect(absent.discoveryFailed).toBe(false);
      expect(absent.stores).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ family: "team-reports", path: null, issues: [] }),
        ]),
      );
      expect(fs.readdirSync(stateDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports all physical state engines despite incompatible configuration without changing artifacts", () => {
    expect(inspection.observed.state).toEqual(["sqlite", "postgres"]);
    expect(inspection.stateRoots.map(({ physical }) => physical.engine)).toEqual([
      "sqlite",
      "postgres",
    ]);
    expect(inspection.discoveryFailed).toBe(true);
    expect(fs.readdirSync(path.join(root, "state"))).toEqual(["openclaw.sqlite"]);
    expect(fs.readdirSync(path.join(root, "voice-calls", "state"))).toEqual(["openclaw.sqlite"]);
  });
});
