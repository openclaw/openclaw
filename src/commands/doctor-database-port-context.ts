import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { z } from "zod";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { readConfigFileSnapshotForWrite } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStateClientCredentialEnvironment } from "../infra/client-credential-paths.js";
import {
  PortClientCredentialMismatchError,
  rebindPortedClientCredentials,
} from "../infra/client-credential-restore.js";
import { DatabasePortError } from "../infra/database-engine/port-command.worker.js";
import type { PortVerification } from "../infra/database-engine/port.worker.js";
import type { PostgresPlannerStatistics } from "../infra/database-engine/postgres-planner-statistics.js";
import {
  resolveDatabaseFamilyEngines,
  listDatabaseEngineStores,
  type DatabaseEngineId,
} from "../infra/database-engine/registry.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import {
  archiveDatabasePortManifest,
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

export const databasePortFamilySchema = z.enum([
  "state",
  "agent",
  "workboard",
  "logbook",
  "team-reports",
]);
export type DatabasePortFamily = z.infer<typeof databasePortFamilySchema>;

export function assertPortSelection(
  config: OpenClawConfig,
  to?: DatabaseEngineId,
  family?: DatabasePortFamily,
) {
  try {
    const engines = resolveDatabaseFamilyEngines(config);
    if (
      !family &&
      new Set(
        listDatabaseEngineStores()
          .filter((store) => store.postgres)
          .map((store) => engines[store.id]),
      ).size > 1
    ) {
      throw new Error(
        "Mixed-engine database port requires --family <state|agent|workboard|logbook|team-reports>; port one family at a time.",
      );
    }
    if (to && !family) {
      const selected = resolveDatabaseFamilyEngines({
        ...config,
        database: { ...config.database, engine: to },
      });
      if (listDatabaseEngineStores().some((store) => store.postgres && selected[store.id] !== to)) {
        throw new Error(
          "Engine-pinning family overrides require --family; port each configured family separately.",
        );
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new DatabasePortError(error.message);
    }
    throw error;
  }
}

export const inputsSchema = z.object({
  // Legacy v1 inputs retain their original global-selection recovery reader.
  originalEngine: z.string().nullable().optional(),
  remainingSqlite: z.array(z.string()).optional(),
  selection: z
    .object({
      path: z.union([
        z.tuple([z.literal("database"), z.literal("engine")]),
        z.tuple([
          z.literal("database"),
          z.literal("families"),
          databasePortFamilySchema,
          z.literal("engine"),
        ]),
      ]),
      originalValue: z.string().nullable(),
      effectiveSource: z.enum(["sqlite", "postgres"]),
    })
    .optional(),
  outOfScope: z
    .array(z.object({ path: z.string(), engine: z.enum(["sqlite", "postgres"]) }))
    .optional(),
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
  plannerStatistics?: Array<{ path: string; result: PostgresPlannerStatistics }>;
  family?: DatabasePortFamily;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  engineSelection: {
    effectiveEngines: DatabaseEngineSelection["effectiveEngines"];
    postgres?: DatabaseEngineSelection["postgres"];
  };
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
export function refuseFailure(ctx: Context, error: unknown): never {
  if (error instanceof PortClientCredentialMismatchError) {
    throw new DatabasePortError(
      `Database port ${ctx.phase}: ${ctx.target}; ${error.message} Restore the archive with openclaw backup restore before retrying.`,
    );
  }
  if (error instanceof DatabasePortError) {
    throw error;
  }
  // Untrusted driver/config messages may contain a DSN or row payload.
  const parsed = z.object({ code: z.string().regex(/^[A-Z0-9_]+$/) }).safeParse(error);
  return refuse(
    ctx,
    parsed.success ? parsed.data.code : "validation or I/O failure",
    "successful verified phase; preserve the recovery directory",
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
  return { ...config, database: { ...config.database, engine: "postgres", families: undefined } };
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

export function finalize(ctx: Context, outcome: "ported" | "rolled-back") {
  ctx.phase = "finalize/archive";
  const current = manifest(ctx);
  if (current.state !== "complete") {
    current.state = "complete";
    current.outcome = outcome;
    revise(ctx);
  }
  // Existing v1 recoveries stored only the profile-global capture at the operation root.
  const legacyBinding = current.artifacts.find(
    (artifact) => artifact.path === path.join(ctx.directory, "client-credential-binding.json"),
  );
  const globalSharedPath = path.join(ctx.stateDir, "state", "openclaw.sqlite");
  if (legacyBinding && !current.targets.some((target) => livePath(target) === globalSharedPath)) {
    refuse(ctx, "credential binding without shared target", "captured shared store");
  }
  for (const [index, target] of current.targets.entries()) {
    const sharedPath = livePath(target);
    const binding =
      current.artifacts.find(
        (artifact) =>
          artifact.path === path.join(storeDirectory(ctx, index), "client-credential-binding.json"),
      ) ?? (sharedPath === globalSharedPath ? legacyBinding : undefined);
    if (!binding) {
      continue;
    }
    ctx.target = sharedPath;
    const input = ctx.inputs?.stores[index];
    const env = resolveStateClientCredentialEnvironment({ path: sharedPath, env: ctx.env });
    if (!input || !env) {
      refuse(ctx, "credential binding without shared target", "captured shared store");
    }
    rebindPortedClientCredentials({
      env,
      binding: JSON.parse(fs.readFileSync(binding.path, "utf8")),
      sharedPath,
      sqliteSnapshotPath: input.image,
      engine: outcome === "ported" ? current.direction.to : current.direction.from,
      storeId: target.storeId,
      assertCurrent: ctx.assertCurrent,
    });
  }
  const archived = archiveDatabasePortManifest(
    ctx.stateDir,
    current.operationId,
    ctx.assertCurrent,
  );
  return {
    phase: "complete",
    engine: outcome === "ported" ? current.direction.to : current.direction.from,
    stores: current.targets.map(livePath),
    plannerStatistics: ctx.plannerStatistics ?? [],
    backup: ctx.directory,
    remainingSqlite:
      ctx.inputs?.outOfScope
        ?.filter((store) => store.engine === "sqlite")
        .map((store) => store.path) ??
      ctx.inputs?.remainingSqlite ??
      [],
    ...(ctx.family ? { family: ctx.family, outOfScope: ctx.inputs?.outOfScope ?? [] } : {}),
    manifest: archived,
    serverCapacity: "unknown; former PostgreSQL namespaces retained",
    restart: "Start the Gateway through its service owner.",
  };
}
