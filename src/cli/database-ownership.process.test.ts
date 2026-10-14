import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowedAtPath,
  inspectOpenClawStateOwnershipAtPath,
  type OpenClawExternalStateOwnership,
} from "../state/openclaw-state-ownership.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function createEnvironment(): NodeJS.ProcessEnv {
  const root = roots.make("openclaw-ownership-claim-");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_SUPERVISOR_MODE: "external",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}\n");
  return env;
}

function claim(env: NodeJS.ProcessEnv, direct = false) {
  return runCliProcessChild({
    nodeArgs: direct
      ? [...entrypoint, "ownership-claim-direct", "--json"]
      : [...entrypoint, "database", "ownership", "claim", "--manager", "supervisor", "--json"],
    env,
  });
}

function snapshot(databasePath: string) {
  return ["", "-wal", "-shm"].map((suffix) => {
    const filename = databasePath + suffix;
    return fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  });
}

describe("database ownership claim process boundary", () => {
  it.each(["gateway", "agent-embedded"] as const)(
    "refuses a live %s owner without changing its database or cached authority",
    async (role) => {
      const env = createEnvironment();
      const port = await acquireTestPortBlock({ offsets: [0] });
      const owner = await acquireGatewayLock({
        env,
        role,
        port: port.port,
        allowInTests: true,
        timeoutMs: 0,
      });
      expect(owner).not.toBeNull();
      try {
        const gatewayEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: undefined };
        const database = openOpenClawStateDatabase({ env: gatewayEnv });
        const before = snapshot(database.path);
        const result = await claim(env);
        expect(result.code, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          error: expect.stringMatching(/stop.*external supervisor/iu),
        });
        assert.deepStrictEqual(snapshot(database.path), before);
        const direct = await claim(env, true);
        expect(direct.code, direct.stderr).toBe(1);
        expect(JSON.parse(direct.stdout)).toMatchObject({
          error: { message: expect.stringMatching(/OpenClaw state database is busy/iu) },
        });
        assert.deepStrictEqual(snapshot(database.path), before);
        expect(inspectOpenClawStateOwnershipAtPath(database.path)).toBeNull();
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            ).run("owner-still-current", "true", 1);
          },
          { env: gatewayEnv, database },
        );
        expect(
          database.db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("owner-still-current"),
        ).toEqual({ value_json: "true" });
      } finally {
        await closeOpenClawStateDatabaseAsync();
        await owner?.release();
        await port.release();
      }
    },
  );

  it.each([false, true])(
    "claims under exclusive offline custody and reclaims idempotently (direct=%s)",
    async (direct) => {
      const env = createEnvironment();
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const first = await claim(env, direct);
      expect(first.code, first.stderr).toBe(0);
      const firstResult: { ownership: OpenClawExternalStateOwnership } = JSON.parse(first.stdout);
      expect(firstResult.ownership).toMatchObject({ managerId: "supervisor", mode: "external" });
      const observation: { pid: number; ownershipWrites: Array<{ pid?: number; role?: string }> } =
        JSON.parse(
          fs.readFileSync(path.join(env.OPENCLAW_HOME!, "control/sql-observation.json"), "utf8"),
        );
      expect(observation.ownershipWrites.length).toBeGreaterThan(0);
      for (const write of observation.ownershipWrites) {
        expect(write).toEqual({
          pid: observation.pid,
          role: direct ? "sqlite-maintenance" : "agent-embedded",
        });
      }
      expect(fs.existsSync(resolveGatewayLockPaths(env).ownerLockPath)).toBe(false);

      const repeated = await claim(env, direct);
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(first.stdout));

      const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
      expect(successor).not.toBeNull();
      try {
        await expect(
          assertOpenClawStateWriteAllowedAtPath({ databasePath, env }),
        ).resolves.toBeUndefined();
        expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(firstResult.ownership);
        await expect(
          assertOpenClawStateWriteAllowedAtPath({
            databasePath,
            env: { ...env, OPENCLAW_SUPERVISOR_MODE: undefined },
          }),
        ).rejects.toThrow(/externally supervised/iu);
      } finally {
        await closeOpenClawStateDatabaseAsync();
        await successor?.release();
      }
    },
  );
});
