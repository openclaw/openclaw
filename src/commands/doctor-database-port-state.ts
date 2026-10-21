import fs from "node:fs";
import path from "node:path";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveDatabaseEngineInput } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import {
  resolveDatabaseFamilyEngines,
  type DatabaseEngineId,
} from "../infra/database-engine/registry.js";
import type { DatabasePortRecoveryIntent } from "../infra/database-port-recovery.js";
import { readBackupEngine } from "../snapshot/database-backup.js";
import {
  type Context,
  postgresConfig,
  readDatabasePortConfigSnapshot,
} from "./doctor-database-port-context.js";

export async function withDatabasePortStateOwner<T>(
  ctx: Context,
  recovery: DatabasePortRecoveryIntent | undefined,
  run: () => Promise<T>,
) {
  const config = (await readDatabasePortConfigSnapshot(ctx)).snapshot.config;
  const shared = path.join(ctx.stateDir, "state", "openclaw.sqlite");
  // Interrupted publication can leave config on the old engine. Custody follows the physical store.
  const engine = fs.existsSync(shared)
    ? readBackupEngine(shared).engine
    : resolveDatabaseFamilyEngines(config).state;
  await selectDatabasePortEngine(ctx, config, engine);
  return withDatabaseEngineSelection(ctx.engineSelection, () =>
    runWithLocalStateOwner({
      method: "database.port",
      params: {},
      target: ctx.stateDir,
      onForeignOwner: "refuse",
      databasePortRecovery: recovery,
      databasePortMaintenance: true,
      runLocal: ({ env, assertCurrent, signal }) => {
        Object.assign(ctx, { env, stateDir: resolveStateDir(env), assertCurrent, signal });
        return run();
      },
    }),
  );
}

export async function selectDatabasePortEngine(
  ctx: Context,
  config: OpenClawConfig,
  engine: DatabaseEngineId | undefined,
) {
  // This task-scoped holder follows offline publication; boot selections remain frozen.
  const effectiveEngines = { ...resolveDatabaseFamilyEngines(config), state: engine ?? "sqlite" };
  Object.assign(ctx.engineSelection, {
    effectiveEngines: Object.freeze(effectiveEngines),
    postgres:
      ctx.engineSelection.postgres ??
      (Object.values(effectiveEngines).includes("postgres")
        ? await resolveDatabaseEngineInput(postgresConfig(config), ctx.env)
        : undefined),
  });
}

export async function closeDatabasePortState(ctx: Context) {
  const { closeOpenClawStateDatabaseByPathAsync } =
    await import("../state/openclaw-state-db-cache.js");
  await closeOpenClawStateDatabaseByPathAsync(path.join(ctx.stateDir, "state", "openclaw.sqlite"));
}

export async function prepareSharedStatePortSource(
  ctx: Context,
  from: DatabaseEngineId,
  to: DatabaseEngineId,
  dryRun?: boolean,
) {
  const shared = path.join(ctx.stateDir, "state", "openclaw.sqlite");
  if (dryRun || from !== "sqlite" || to !== "postgres" || fs.existsSync(shared)) {
    return;
  }
  const { captureOpenClawStateWorkerContext } =
    await import("../state/openclaw-state-worker-context.js");
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  // The config writer needs shared state; include its canonical first-use store in the capture.
  await runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext({ env: ctx.env }),
    async () => {},
    { assertCurrent: ctx.assertCurrent },
  );
  await closeDatabasePortState(ctx);
}
