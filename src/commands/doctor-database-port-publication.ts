import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { runDatabasePortTask } from "../infra/database-engine/port-command.worker.js";
import type { PortVerification } from "../infra/database-engine/port.worker.js";
import {
  createVerifiedSqliteSnapshot,
  prepareVerifiedSqliteFile,
} from "../infra/sqlite-snapshot.js";
import {
  assertDatabaseArtifact,
  captureDatabaseArtifact,
  preparePostgresRestore,
  readBackupEngine,
} from "../snapshot/database-backup.js";
import {
  type Context,
  livePath,
  manifest,
  postgresConfig,
  privatePaths,
  record,
  refuse,
  revise,
  stagePath,
  storeAt,
  storeDirectory,
} from "./doctor-database-port-context.js";
import { closeDatabasePortState } from "./doctor-database-port-state.js";

async function verify(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  original = false,
  sourcePath?: string,
  receipt?: PortVerification,
) {
  ctx.phase = "verify";
  const current = manifest(ctx),
    { target } = storeAt(ctx, index);
  ctx.target = livePath(target);
  const proofFile = path.join(
    storeDirectory(ctx, index),
    original && target.original.engine === "postgres"
      ? "postgres/manifest.json"
      : "verification.json",
  );
  const parsed = JSON.parse(fs.readFileSync(proofFile, "utf8"));
  const proof: PortVerification =
    receipt ?? (original && target.original.engine === "postgres" ? parsed.verification : parsed);
  const location =
    sourcePath && original && current.direction.from === "postgres"
      ? readBackupEngine(sourcePath)
      : original
        ? target.original
        : target.intended;
  await runDatabasePortTask(
    {
      operation: "verify",
      sourcePath: sourcePath ?? (original ? target.originalCapture.path : stagePath(ctx, index)),
      engine: original ? current.direction.from : current.direction.to,
      storeId: target.storeId,
      namespace: location.engine === "postgres" ? location.namespace : "",
      verification: proof,
      config: postgresConfig(config),
    },
    ctx,
  );
}

export async function assertOriginal(ctx: Context, index: number, config: OpenClawConfig) {
  const { target, input: store } = storeAt(ctx, index);
  ctx.target = store.original.path;
  privatePaths(ctx, [store.original.path]);
  const stat = fs.lstatSync(store.original.path, { bigint: true });
  if (String(stat.dev) !== store.dev || String(stat.ino) !== store.ino) {
    refuse(ctx, "changed source identity", "captured device and inode");
  }
  if (
    ctx.stateReceipt?.path === ctx.target &&
    ctx.stateReceipt.engine === manifest(ctx).direction.from
  ) {
    await verify(ctx, index, config, true, ctx.target, ctx.stateReceipt.verification);
    return;
  }
  if (target.original.engine === "postgres") {
    await verify(ctx, index, config, true);
    return;
  }
  const copy = path.join(storeDirectory(ctx, index), `source-check-${randomUUID()}.sqlite`);
  await createVerifiedSqliteSnapshot({
    sourcePath: store.original.path,
    targetPath: copy,
    preserveRowIds: true,
  });
  if (
    (await captureDatabaseArtifact(copy)).sha256 !==
    (await captureDatabaseArtifact(store.image)).sha256
  ) {
    refuse(ctx, "changed source data", "captured original SQLite image");
  }
}
export async function prepareStores(ctx: Context, config: OpenClawConfig, restoring: boolean) {
  ctx.phase = restoring ? "rollback" : "prepare stores";
  const current = manifest(ctx);
  for (const [index, target] of current.targets.entries()) {
    ctx.target = livePath(target);
    privatePaths(ctx, [ctx.target]);
    const actual = await captureDatabaseArtifact(ctx.target);
    const receipt = ctx.stateReceipt?.path === ctx.target ? ctx.stateReceipt : undefined;
    if (restoring && receipt) {
      // SQLite WAL and PostgreSQL rows can change without changing the anchor file.
      await verify(
        ctx,
        index,
        config,
        receipt.engine === current.direction.from,
        ctx.target,
        receipt.verification,
      );
    }
    const staged = current.artifacts.find((file) => file.path === stagePath(ctx, index));
    const restored =
      receipt?.engine === current.direction.from ||
      actual.sha256 === target.originalCapture.sha256 ||
      current.artifacts.some(
        (file) => path.basename(file.path).startsWith("rollback-") && file.sha256 === actual.sha256,
      );
    const fresh =
      receipt?.engine === current.direction.to || (staged && actual.sha256 === staged.sha256);
    if (!fresh && !(restoring && restored)) {
      if (restoring && target.original.engine === "postgres") {
        await assertDatabaseArtifact(storeAt(ctx, index).input.original);
      } else {
        await assertOriginal(ctx, index, config);
      }
    }
    if (!restoring && fresh) {
      await verify(
        ctx,
        index,
        config,
        false,
        receipt ? ctx.target : undefined,
        receipt?.verification,
      );
      continue;
    }
    let source = restoring ? target.originalCapture.path : stagePath(ctx, index);
    if (
      restoring &&
      target.original.engine === "postgres" &&
      receipt?.engine !== current.direction.from
    ) {
      try {
        await verify(ctx, index, config, true, !fresh ? ctx.target : undefined);
      } catch {
        source = path.join(storeDirectory(ctx, index), `rollback-${randomUUID()}.sqlite`);
        await preparePostgresRestore({
          directory: path.dirname(target.originalCapture.path),
          anchorPath: source,
          profile: "exact",
          config: postgresConfig(config),
          expectedSource: { storeId: target.storeId, namespace: target.original.namespace },
          assertCurrent: ctx.assertCurrent,
        });
        current.artifacts.push(await captureDatabaseArtifact(source));
        revise(ctx);
      }
    }
    if (restoring && (restored || !fresh) && source === target.originalCapture.path) {
      continue;
    }
    if (!restoring) {
      await verify(ctx, index, config);
    }
    ctx.phase = restoring ? "rollback" : "publish stores";
    await runDatabasePortTask({ operation: "checkpoint", sourcePath: ctx.target }, ctx);
    const settled = await captureDatabaseArtifact(ctx.target),
      bytes = await captureDatabaseArtifact(source);
    const image = await prepareVerifiedSqliteFile({
      sourcePath: source,
      sourceIdentity: fs.lstatSync(source, { bigint: true }),
      targetPath: ctx.target,
      expectedContent: { sha256: bytes.sha256, sizeBytes: bytes.size },
      replaceExisting: {
        expectedIdentity: fs.lstatSync(ctx.target, { bigint: true }),
        expectedContent: { sha256: settled.sha256, sizeBytes: settled.size },
        assertCustody: ctx.assertCurrent,
      },
    });
    ctx.prepared.push([ctx.target, image]);
  }
}
export async function publishStores(ctx: Context) {
  ctx.phase = "publish stores";
  const current = manifest(ctx);
  ctx.target = ctx.prepared[0]?.[0] ?? ctx.configPath;
  if (current.state === "preparing") {
    current.state = "publishing";
    revise(ctx);
  }
  await closeDatabasePortState(ctx);
  for (const [target, image] of ctx.prepared) {
    ctx.target = target;
    await image.publish();
  }
}

/** Config writes can change shared state after its immutable port capture. */
export async function withDatabasePortConfigStateReceipt<T>(
  ctx: Context,
  config: OpenClawConfig,
  run: () => Promise<T>,
): Promise<T> {
  const file = path.join(ctx.stateDir, "state", "openclaw.sqlite");
  if (!manifest(ctx).targets.some((target) => livePath(target) === file)) {
    return await run();
  }
  try {
    return await run();
  } finally {
    // The enclosing offline owner excludes other writers through the effect and receipt.
    ctx.assertCurrent();
    await closeDatabasePortState(ctx);
    const { engine } = readBackupEngine(file);
    const { verification } = await runDatabasePortTask(
      { operation: "inspect", sourcePath: file, config: postgresConfig(config), to: engine },
      ctx,
    );
    const receipt = { path: file, engine, verification: verification! };
    await record(ctx, path.join(ctx.directory, `config-state-${randomUUID()}.json`), receipt);
    ctx.stateReceipt = receipt;
  }
}

export function loadDatabasePortStateReceipt(ctx: Context): void {
  const receipt = manifest(ctx).artifacts.findLast((artifact) =>
    artifact.path.startsWith(path.join(ctx.directory, "config-state-")),
  );
  if (receipt) {
    // SAFETY: loadRecovery verified the private artifact's recorded digest.
    ctx.stateReceipt = JSON.parse(fs.readFileSync(receipt.path, "utf8")) as Context["stateReceipt"];
  }
}
