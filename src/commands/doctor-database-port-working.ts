import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { runDatabasePortTask } from "../infra/database-engine/port-command.worker.js";
import { syncDatabasePortPath } from "../infra/database-port-recovery.js";
import {
  createPrivateSqliteTempDirectory,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "../infra/sqlite-private-directory.js";
import { publishVerifiedSqliteFile } from "../infra/sqlite-snapshot.js";
import { resolvePathJournalPolicy } from "../infra/sqlite-wal-filesystem.js";
import { withStateInspectionCleanup } from "../infra/update-candidate-state.process.js";
import { captureDatabaseArtifact } from "../snapshot/database-backup.js";
import {
  type Context,
  manifest,
  refuse,
  revise,
  storeAt,
  storeDirectory,
} from "./doctor-database-port-context.js";

async function copyPortArtifact(
  ctx: Context,
  source: Awaited<ReturnType<typeof captureDatabaseArtifact>>,
  targetPath: string,
) {
  await publishVerifiedSqliteFile({
    sourcePath: source.path,
    sourceIdentity: fs.lstatSync(source.path, { bigint: true }),
    targetPath,
    expectedContent: { sha256: source.sha256, sizeBytes: source.size },
    beforePublish: ctx.assertCurrent,
    afterPublish: (guard) => {
      guard.assertTargetUnchanged(ctx.assertCurrent);
    },
  });
}

async function privateMigrate(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  localPath: string,
) {
  ctx.phase = "private migrate";
  const current = manifest(ctx);
  const prefix = path.join(storeDirectory(ctx, index), "working-");
  const recorded = current.artifacts.find((file) => file.path.startsWith(prefix));
  const source =
    recorded ?? current.artifacts.find((file) => file.path === storeAt(ctx, index).input.image);
  if (!source) {
    refuse(ctx, "missing recorded original image", "manifest-bound SQLite capture");
  }
  // Copy pinned bytes without reopening the durable capture through SQLite.
  await copyPortArtifact(ctx, source, localPath);
  if (recorded) {
    return;
  }
  await runDatabasePortTask({ operation: "migrate", sourcePath: localPath, config }, ctx);
  await runDatabasePortTask({ operation: "checkpoint", sourcePath: localPath }, ctx);
  syncDatabasePortPath(localPath);
  const qualified = await captureDatabaseArtifact(localPath);
  const file = `${prefix}${randomUUID()}.sqlite`;
  await copyPortArtifact(ctx, qualified, file);
  current.artifacts.push({ ...qualified, path: file });
  revise(ctx);
}

/** Preserve the durable journal while SQL consumes a rebuildable private image. */
export async function withDatabasePortWorkingCopy<T>(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  run: (working: string) => Promise<T>,
): Promise<T> {
  const root = resolvePrivateSqliteSnapshotStagingRoot(ctx.env);
  if (resolvePathJournalPolicy(root) !== "wal") {
    refuse(ctx, "nonlocal or unclassified working cache", "XDG_CACHE_HOME on a local filesystem");
  }
  const scratch = await createPrivateSqliteTempDirectory(root, "database-port-working-");
  const working = path.join(scratch, "database.sqlite");
  // Failed workers may retain native custody: keep scratch on failure, cleaning
  // only after migration, checkpoint and the consuming stage have all joined.
  await privateMigrate(ctx, index, config, working);
  const result = await run(working);
  return withStateInspectionCleanup(scratch, async () => result);
}
