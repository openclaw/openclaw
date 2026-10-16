import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { z } from "zod";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { readConfigFileSnapshotForWrite } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.js";
import { DatabasePortError } from "../infra/database-engine/port-command.worker.js";
import type { PortVerification } from "../infra/database-engine/port.worker.js";
import type { DatabaseEngineInput } from "../infra/database-engine/types.js";
import {
  databasePortManifestPath,
  databasePortArtifactSchema,
  writeDatabasePortArtifact,
  writeDatabasePortManifest,
  type DatabasePortManifest,
} from "../infra/database-port-recovery.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import type { prepareVerifiedSqliteFile } from "../infra/sqlite-snapshot.js";
import { captureDatabaseArtifact } from "../snapshot/database-backup.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

export const inputsSchema = z.object({
  originalEngine: z.string().nullable(),
  remainingSqlite: z.array(z.string()),
  stores: z.array(
    z.object({
      dev: z.string(),
      ino: z.string(),
      image: z.string(),
      original: databasePortArtifactSchema,
    }),
  ),
});
export type Context = {
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  engineSelection: { input: DatabaseEngineInput };
  stateReceipt?: {
    path: string;
    engine: "sqlite" | "postgres";
    verification: PortVerification;
  };
  assertCurrent: () => void;
  signal?: AbortSignal;
  phase: string;
  target: string;
  directory: string;
  manifest?: DatabasePortManifest;
  inputs?: z.infer<typeof inputsSchema>;
  prepared: [string, Awaited<ReturnType<typeof prepareVerifiedSqliteFile>>][];
};
export function refuse(ctx: Context, observed: string, required: string): never {
  throw new DatabasePortError(
    `Database port ${ctx.phase}: ${ctx.target}; observed ${observed}; required ${required}. Stop the Gateway first; correct this fact and retry, or use --resume/--rollback with ${databasePortManifestPath(ctx.stateDir)}.`,
  );
}
export const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
export function manifest(ctx: Context) {
  return ctx.manifest!;
}
export function storeAt(ctx: Context, index: number) {
  return { target: manifest(ctx).targets[index]!, input: ctx.inputs!.stores[index]! };
}
export const storeDirectory = (ctx: Context, index: number) =>
  path.join(ctx.directory, String(index));
export const stagePath = (ctx: Context, index: number) =>
  path.join(storeDirectory(ctx, index), "target.sqlite");
export const livePath = (target: DatabasePortManifest["targets"][number]) =>
  target.original.engine === "sqlite" ? target.original.path : target.original.anchorPath;
export function revise(ctx: Context) {
  const current = manifest(ctx);
  writeDatabasePortManifest(
    ctx.stateDir,
    { ...current, revision: current.revision + 1 },
    ctx.assertCurrent,
  );
  current.revision++;
}
export async function record(ctx: Context, file: string, value: unknown) {
  const contents = `${JSON.stringify(value)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== contents) {
      refuse(ctx, "changed private artifact", "recorded artifact contents");
    }
  } else {
    writeDatabasePortArtifact(file, contents, ctx.assertCurrent);
  }
  manifest(ctx).artifacts.push(await captureDatabaseArtifact(file));
  revise(ctx);
}
export function privatePaths(ctx: Context, files: string[]) {
  for (const file of files) {
    ctx.target = file;
    try {
      assertDoctorSqliteMaintenancePathsNotAliased(
        "database port",
        [file],
        [ctx.stateDir, path.dirname(ctx.configPath)],
      );
    } catch {
      refuse(ctx, "aliased or inaccessible path", "an owned path without symbolic or hard links");
    }
  }
}
export async function configInputs(ctx: Context) {
  const raw = fs.readFileSync(ctx.configPath, "utf8");
  const files = [
    ctx.configPath,
    ...(await collectIncludePathsRecursive({
      configPath: ctx.configPath,
      parsed: parseJsonWithJson5Fallback(raw),
      env: ctx.env,
    })),
  ];
  privatePaths(ctx, files);
  return await Promise.all(files.map(captureDatabaseArtifact));
}
export async function readDatabasePortConfigSnapshot(ctx: Context) {
  ctx.assertCurrent();
  const value = await readConfigFileSnapshotForWrite({
    observe: false,
    skipPluginValidation: true,
  });
  if (!value.snapshot.valid || value.snapshot.path !== ctx.configPath) {
    refuse(ctx, "invalid or changed configuration", "valid pinned config source");
  }
  privatePaths(ctx, Object.keys(value.writeOptions.includeFileTargetsForWrite ?? {}));
  return value;
}
export function postgresConfig(config: OpenClawConfig): OpenClawConfig {
  return { ...config, database: { ...config.database, engine: "postgres" } };
}
export function capacity(ctx: Context, files: { path: string; size: number }[]) {
  const volumes = new Map<number, { path: string; required: number }>();
  for (const file of files) {
    const dev = fs.statSync(file.path).dev;
    const volume = volumes.get(dev) ?? { path: file.path, required: 1024 ** 3 };
    volume.required += file.size * 7;
    volumes.set(dev, volume);
  }
  for (const volume of volumes.values()) {
    const free = tryReadDiskSpace(volume.path);
    if (free && free.availableBytes < volume.required) {
      refuse(
        ctx,
        `${free.availableBytes} bytes free on ${volume.path}`,
        `${volume.required} bytes for captures, migration, indexes and publication`,
      );
    }
  }
}
