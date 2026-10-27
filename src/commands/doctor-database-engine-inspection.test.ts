import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
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
