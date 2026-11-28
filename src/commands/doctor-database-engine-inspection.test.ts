import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeFixtureJsonSync } from "../cli/cli-fixtures.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolvePluginSourceCaptureFallbackPrefix } from "../plugins/plugin-source-capture-path.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

// An installed plugin outside the memory slot never runs, but Doctor still reads its
// contract. Each `doctor --lint` used to leave that package's capture in the temp directory.
it("removes an installed plugin's Doctor contract capture when inspection ends", () =>
  withOpenClawTestState(
    { label: "doctor-engine-contract-capture", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const pluginId = "inactive-memory";
      const packageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "inactive-memory-package",
        pluginId,
        version: "1.0.0",
      });
      writeFixtureJsonSync(path.join(packageDir, "openclaw.plugin.json"), {
        id: pluginId,
        kind: "memory",
        doctorContract: { stateMigrations: [{ id: "inactive-memory-rows" }] },
        configSchema: { type: "object" },
      });
      fs.writeFileSync(
        path.join(packageDir, "dist", "doctor-contract-api.js"),
        `export const stateMigrations = [{
  id: "inactive-memory-rows",
  label: "Inactive memory rows",
  detectLegacyState: async () => null,
  migrateLegacyState: async () => ({ changes: [], warnings: [] }),
}];
`,
      );
      const config = {
        plugins: { entries: { [pluginId]: { enabled: true } }, slots: { memory: "memory-core" } },
      };
      await state.writeConfig(config);
      await seedInstalledPluginIndex(
        { [pluginId]: { source: "npm", installPath: packageDir } },
        { config, env: state.env },
      );
      // The fallback prefix hashes this fresh state dir, so no other run shares it.
      const prefix = resolvePluginSourceCaptureFallbackPrefix(state.stateDir);

      const inspection = await inspectDoctorDatabaseEngines({
        config,
        stateDir: state.stateDir,
        env: state.env,
      });

      // "none" (not "unknown") proves Doctor loaded the contract it inspected.
      expect(inspection.stores.map((store) => store.legacyMigrations?.state)).not.toContain(
        "unknown",
      );
      expect(fs.readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))).toEqual([]);
    },
  ));
