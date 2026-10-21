import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership-preflight.js";
import {
  inspectOpenClawStateOwnershipAtPath,
  type OpenClawExternalStateOwnership,
} from "../state/openclaw-state-ownership.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { runStateOwnerCli, stateOwnerEnv } from "./cli-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = stateOwnerEnv(roots.make("oc-owner-"), { OPENCLAW_SUPERVISOR_MODE: "external" });
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, "{}\n");
});

async function claim(direct = false, code = 0) {
  const result = await runStateOwnerCli(
    env,
    direct
      ? ["ownership-claim-direct", "--json"]
      : ["database", "ownership", "claim", "--manager", "supervisor", "--json"],
  );
  expect(result.code, result.stderr).toBe(code);
  return JSON.parse(result.stdout);
}

function snapshot(databasePath: string) {
  return ["", "-wal", "-shm"].map((suffix) => {
    const filename = databasePath + suffix;
    return fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  });
}

it.each(["gateway", "agent-embedded"] as const)(
  "refuses a live %s owner without changing its database or cached authority",
  async (role) => {
    const port = await acquireTestPortBlock({ offsets: [0] });
    const options = { env, role, port: port.port, allowInTests: true, timeoutMs: 0 };
    const owner = await acquireGatewayLock(options);
    expect(owner).not.toBeNull();
    try {
      const gatewayEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: undefined };
      const database = openOpenClawStateDatabase({ env: gatewayEnv });
      const before = snapshot(database.path);
      for (const [direct, error] of [
        [false, expect.stringMatching(/stop.*external supervisor/iu)],
        [true, { message: expect.stringMatching(/OpenClaw state database is busy/iu) }],
      ] as const) {
        expect(await claim(direct, 1)).toMatchObject({ error });
        expect(snapshot(database.path)).toEqual(before);
      }
      expect(inspectOpenClawStateOwnershipAtPath(database.path)).toBeNull();
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          db
            .prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            )
            .run("owner-still-current", "true", 1),
        { env: gatewayEnv, database },
      );
      const row = database.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("owner-still-current");
      expect(row).toEqual({ value_json: "true" });
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
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const checkWrite = (sourceEnv = env) =>
      assertOpenClawStateWriteAllowedAtPath({ databasePath, env: sourceEnv });
    const firstResult: { ownership: OpenClawExternalStateOwnership } = await claim(direct);
    expect(firstResult.ownership).toMatchObject({ managerId: "supervisor", mode: "external" });
    const observation: { pid: number; ownershipWrites: Array<{ pid?: number; role?: string }> } =
      JSON.parse(
        fs.readFileSync(path.join(env.OPENCLAW_HOME!, "control/sql-observation.json"), "utf8"),
      );
    expect(observation.ownershipWrites.length).toBeGreaterThan(0);
    const role = direct ? "sqlite-maintenance" : "agent-embedded";
    for (const write of observation.ownershipWrites) {
      expect(write).toEqual({ pid: observation.pid, role });
    }
    expect(fs.existsSync(resolveGatewayLockPaths(env).ownerLockPath)).toBe(false);

    expect(await claim(direct)).toEqual(firstResult);

    const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    try {
      await expect(checkWrite()).resolves.toBeUndefined();
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(firstResult.ownership);
      await expect(checkWrite({ ...env, OPENCLAW_SUPERVISOR_MODE: undefined })).rejects.toThrow(
        /externally supervised/iu,
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await successor?.release();
    }
  },
);
