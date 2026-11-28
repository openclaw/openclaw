import { hostname } from "node:os";
import path from "node:path";
import * as pidAlive from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { acquireGatewayOwnerLease, type GatewayOwnerLease } from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

export function createGatewayOwnerLeaseFixtures(tempDirs: { make(prefix: string): string }) {
  function fixture() {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-") };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const coordinator = acquireGatewayStateOwner({
      databasePath,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        role: "gateway",
        processNamespace: readGatewayLockProcessNamespace(),
      },
    });
    let lease: GatewayOwnerLease | undefined;
    return {
      env,
      acquire(params: Partial<Omit<Parameters<typeof acquireGatewayOwnerLease>[0], "env">> = {}) {
        lease = acquireGatewayOwnerLease({
          env,
          port: 19483,
          mode: "foreground",
          supervisor: null,
          ...params,
        });
        return lease;
      },
      async [Symbol.asyncDispose]() {
        try {
          await lease?.ready;
        } finally {
          await lease?.release();
          coordinator.release();
        }
      },
    };
  }

  function seedOwner(
    env: NodeJS.ProcessEnv,
    {
      pid = process.pid,
      host = hostname(),
      startedAt = pidAlive.getFileLockProcessStartTime(process.pid),
      expiresAt = Date.now() + 300_000,
      heartbeatAt = Date.now(),
      processNamespace = readGatewayLockProcessNamespace(),
      machineIdentity: ownerMachineIdentity,
    }: {
      pid?: number;
      host?: string;
      startedAt?: number | null;
      expiresAt?: number | null;
      heartbeatAt?: number;
      processNamespace?: unknown;
      machineIdentity?: string | null;
    } = {},
  ) {
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        db.prepare(
          `INSERT INTO state_leases
           (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
           VALUES ('gateway-owner', 'global', 'previous-generation', ?, ?, ?, ?, ?)`,
        ).run(
          expiresAt,
          heartbeatAt,
          JSON.stringify({
            owner: {
              pid,
              host,
              processNamespace,
              startedAt,
              machineIdentity: ownerMachineIdentity,
            },
            port: 19483,
            mode: "foreground",
            supervisor: null,
          }),
          Date.now(),
          Date.now(),
        );
      },
      { env },
    );
  }

  async function seedClosedOwner(
    params: Parameters<typeof seedOwner>[1] = {},
    setup?: (env: NodeJS.ProcessEnv) => void,
  ) {
    let env: NodeJS.ProcessEnv;
    {
      await using owner = fixture();
      env = owner.env;
      seedOwner(env, params);
      setup?.(env);
    }
    await closeOpenClawStateDatabaseAsync();
    return env;
  }

  return { fixture, seedOwner, seedClosedOwner };
}

export function acquireLock(
  env: NodeJS.ProcessEnv,
  params: Partial<Parameters<typeof acquireGatewayLock>[0]> = {},
) {
  return acquireGatewayLock({
    env,
    allowInTests: true,
    port: 19483,
    listenerMode: "foreground",
    ...params,
  });
}
