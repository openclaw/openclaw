import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { createPathResolutionEnv } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { readConfigSnapshotForEngineSelection } from "./config-preflight-snapshot.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { mode: "default", isolated: false, options: undefined },
  { mode: "isolated", isolated: true, options: { isolateEnv: true } },
  { mode: "shared", isolated: false, options: { isolateEnv: false } },
])(
  "selects the final PostgreSQL target using the supplied environment ($mode)",
  async ({ isolated, options }) => {
    const home = dirs.make("openclaw-engine-target-");
    const bootstrap = path.join(home, ".openclaw");
    const target = path.join(home, "target");
    fs.mkdirSync(bootstrap);
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(bootstrap, "openclaw.json"),
      JSON.stringify({
        env: {
          vars: {
            OPENCLAW_STATE_DIR: target,
            ENGINE_TARGET_TEST_DSN: "postgresql://synthetic@127.0.0.1:1/engine_target",
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(target, "openclaw.json"),
      JSON.stringify({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "ENGINE_TARGET_TEST_DSN" },
          },
        },
      }),
    );
    const env = createPathResolutionEnv(home, {
      OPENCLAW_CONFIG_PATH: undefined,
      ENGINE_TARGET_TEST_DSN: undefined,
    });
    const before = { ...env };
    const processEnv = { ...process.env };
    const sql = observeMainThreadSql();
    try {
      resetDatabaseEngineSelectionForTest();
      const snapshot = await readConfigSnapshotForEngineSelection(env, options);
      expect(snapshot).toMatchObject({
        valid: true,
        path: path.join(target, "openclaw.json"),
        config: { database: { engine: "postgres" } },
      });
      expect(getDatabaseEngineSelection()).toMatchObject({
        effectiveEngines: { state: "postgres", agent: "postgres" },
        postgres: { connection: "postgresql://synthetic@127.0.0.1:1/engine_target" },
      });
      expect(
        Object.keys({ ...before, ...env })
          .filter((key) => before[key] !== env[key])
          .toSorted(),
      ).toEqual(isolated ? [] : ["ENGINE_TARGET_TEST_DSN", "OPENCLAW_STATE_DIR"]);
      expect(
        Object.keys({ ...processEnv, ...process.env }).filter(
          (key) => processEnv[key] !== process.env[key],
        ),
      ).toEqual([]);
      expect(fs.readdirSync(bootstrap)).toEqual(["openclaw.json"]);
      expect(fs.readdirSync(target)).toEqual(["openclaw.json"]);
      sql.expectIdle();
    } finally {
      sql.restore();
      resetDatabaseEngineSelectionForTest();
    }
  },
);
