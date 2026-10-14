/* oxlint-disable max-lines -- Offline port phases share one manifest and custody context. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { z } from "zod";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { setConfigValueAtPath } from "../config/config-paths.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { withConfigWriteLock } from "../config/write-lock.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import {
  runWorkboardPortTask,
  type WorkboardPortInspection,
  WorkboardPortError,
} from "../infra/database-engine/port-command.worker.js";
import type { PortVerification } from "../infra/database-engine/port.worker.js";
import type { DatabaseEngineId } from "../infra/database-engine/registry.js";
import {
  archiveDatabasePortManifest,
  assertDatabasePortRecoveryAllowed,
  databasePortManifestPath,
  databasePortArtifactSchema,
  prepareDatabasePortDirectory,
  syncDatabasePortPath,
  writeDatabasePortArtifact,
  writeDatabasePortManifest,
  type DatabasePortManifest,
} from "../infra/database-port-recovery.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import {
  createVerifiedSqliteSnapshot,
  prepareVerifiedSqliteFile,
} from "../infra/sqlite-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  assertDatabaseArtifact,
  captureDatabaseArtifact,
  capturePostgresBackup,
  preparePostgresRestore,
  readBackupEngine,
} from "../snapshot/database-backup.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

export type DatabasePortOptions = {
  to?: DatabaseEngineId;
  dryRun?: boolean;
  resume?: string;
  rollback?: string;
};
const inputsSchema = z.object({
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
type Context = {
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  signal?: AbortSignal;
  phase: string;
  target: string;
  directory: string;
  manifest?: DatabasePortManifest;
  inputs?: z.infer<typeof inputsSchema>;
  prepared: [string, Awaited<ReturnType<typeof prepareVerifiedSqliteFile>>][];
};
function refuse(ctx: Context, observed: string, required: string): never {
  throw new WorkboardPortError(
    `Database port ${ctx.phase}: ${ctx.target}; observed ${observed}; required ${required}. Stop the Gateway first; correct this fact and retry, or use --resume/--rollback with ${databasePortManifestPath(ctx.stateDir)}.`,
  );
}
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
function manifest(ctx: Context) {
  return ctx.manifest!;
}
function storeAt(ctx: Context, index: number) {
  return { target: manifest(ctx).targets[index]!, input: ctx.inputs!.stores[index]! };
}
const storeDirectory = (ctx: Context, index: number) => path.join(ctx.directory, String(index));
const stagePath = (ctx: Context, index: number) =>
  path.join(storeDirectory(ctx, index), "target.sqlite");
const livePath = (target: DatabasePortManifest["targets"][number]) =>
  target.original.engine === "sqlite" ? target.original.path : target.original.anchorPath;
function revise(ctx: Context) {
  const current = manifest(ctx);
  current.revision++;
  writeDatabasePortManifest(ctx.stateDir, current, ctx.assertCurrent);
}
async function record(ctx: Context, file: string, value: unknown) {
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
function privatePaths(ctx: Context, files: string[]) {
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
async function configInputs(ctx: Context) {
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
async function snapshot(ctx: Context) {
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
function postgresConfig(config: OpenClawConfig): OpenClawConfig {
  return { ...config, database: { ...config.database, engine: "postgres" } };
}
function capacity(ctx: Context, files: { path: string; size: number }[]) {
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

async function preflight(ctx: Context, options: DatabasePortOptions) {
  ctx.phase = "preflight";
  const captured = await configInputs(ctx),
    current = await snapshot(ctx);
  for (const input of captured) {
    await assertDatabaseArtifact(input);
  }
  const config = current.snapshot.config;
  const from = config.database?.engine ?? "sqlite",
    to = options.to!;
  const plugins = resolvePluginMetadataSnapshot({ stateDir: ctx.stateDir, config, env: ctx.env });
  const roots = plugins.plugins
    .filter((plugin) => plugin.id === "workboard")
    .flatMap((plugin) =>
      (plugin.backupResources ?? [])
        .filter((resource) => resource.scope === "state" && resource.disposition === "include")
        .map((resource) => path.join(ctx.stateDir, resource.relativePath)),
    );
  privatePaths(ctx, roots);
  const all = await discoverBackupDatabasePaths({ stateDir: ctx.stateDir, config, env: ctx.env });
  const stores = all.filter((file) =>
    roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
  );
  const inspected = new Map<string, WorkboardPortInspection>();
  for (const file of all) {
    ctx.target = file;
    privatePaths(ctx, [file]);
    if (!stores.includes(file)) {
      if (readBackupEngine(file).engine !== "sqlite") {
        refuse(ctx, "unclassified PostgreSQL anchor", "registered workboard ownership");
      }
      continue;
    }
    const facts = await runWorkboardPortTask(
      { operation: "inspect", sourcePath: file, config: postgresConfig(config), to },
      ctx,
    );
    if (facts.engine !== from) {
      refuse(ctx, `${facts.engine} store with ${from} config`, "matching physical/config engines");
    }
    inspected.set(file, facts);
  }
  capacity(
    ctx,
    stores.map((file) => ({ path: file, size: fs.statSync(file).size })),
  );
  if (stores.length && from !== to) {
    await runWorkboardPortTask(
      { operation: "preflight", config: postgresConfig(config), probe: false },
      ctx,
    );
  }
  return {
    snapshot: current,
    configInputs: captured,
    from,
    to,
    stores,
    inspected,
    migrations: stores.filter((file) => inspected.get(file)?.migrationRequired),
    remainingSqlite: all.filter((file) => !stores.includes(file)),
  };
}

async function captureOriginals(ctx: Context, facts: Awaited<ReturnType<typeof preflight>>) {
  ctx.phase = "capture originals";
  ctx.assertCurrent();
  const operationId = randomUUID();
  ctx.directory = prepareDatabasePortDirectory(ctx.stateDir, operationId);
  const artifacts: DatabasePortManifest["artifacts"] = [],
    targets: DatabasePortManifest["targets"] = [];
  const authored = facts.snapshot.snapshot.authoredConfig ?? facts.snapshot.snapshot.sourceConfig;
  ctx.inputs = {
    stores: [],
    remainingSqlite: facts.remainingSqlite,
    originalEngine: authored.database?.engine ?? null,
  };
  for (const [index, [file, info]] of [...facts.inspected].entries()) {
    ctx.target = file;
    ctx.assertCurrent();
    const directory = storeDirectory(ctx, index);
    fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(file, { bigint: true }),
      original = await captureDatabaseArtifact(file);
    let image = path.join(directory, "original.sqlite"),
      anchor = image;
    if (facts.from === "postgres") {
      const pg = path.join(directory, "postgres");
      await capturePostgresBackup({
        sourcePath: file,
        directory: pg,
        config: postgresConfig(facts.snapshot.snapshot.config),
        profile: "exact",
        assertCurrent: ctx.assertCurrent,
      });
      image = path.join(pg, "database.sqlite");
      anchor = path.join(pg, "anchor.sqlite");
      artifacts.push(
        ...(await Promise.all(
          [image, anchor, path.join(pg, "manifest.json")].map(captureDatabaseArtifact),
        )),
      );
    } else {
      await createVerifiedSqliteSnapshot({
        sourcePath: file,
        targetPath: image,
        preserveRowIds: true,
      });
      artifacts.push(await captureDatabaseArtifact(image));
    }
    await assertDatabaseArtifact(original);
    ctx.inputs.stores.push({
      dev: String(stat.dev),
      ino: String(stat.ino),
      original,
      image,
    });
    const storeId = info.storeId ?? randomUUID();
    targets.push({
      storeId,
      sourceSchemaVersion: info.version,
      targetSchemaVersion: info.targetVersion,
      descriptorHash: info.descriptorHash,
      original:
        facts.from === "sqlite"
          ? { engine: "sqlite", path: file }
          : { engine: "postgres", anchorPath: file, namespace: info.namespace! },
      intended:
        facts.to === "sqlite"
          ? { engine: "sqlite", path: file }
          : {
              engine: "postgres",
              anchorPath: file,
              namespace: `port_${randomUUID().replaceAll("-", "")}`,
            },
      originalCapture: await captureDatabaseArtifact(anchor),
      verification: null,
    });
  }
  for (const [index, input] of facts.configInputs.entries()) {
    await assertDatabaseArtifact(input);
    const file = path.join(ctx.directory, `config-${index}.json`);
    writeDatabasePortArtifact(file, fs.readFileSync(input.path), ctx.assertCurrent);
    artifacts.push(await captureDatabaseArtifact(file));
  }
  const inputFile = path.join(ctx.directory, "inputs.json");
  writeDatabasePortArtifact(inputFile, `${JSON.stringify(ctx.inputs)}\n`, ctx.assertCurrent);
  artifacts.push(await captureDatabaseArtifact(inputFile));
  const root = fs.lstatSync(ctx.stateDir, { bigint: true });
  ctx.manifest = {
    version: 1,
    operationId,
    revision: 1,
    state: "preparing",
    root: { stateDir: ctx.stateDir, dev: String(root.dev), ino: String(root.ino) },
    direction: { from: facts.from, to: facts.to },
    originalConfig: facts.configInputs,
    artifacts,
    targets,
  };
  writeDatabasePortManifest(ctx.stateDir, ctx.manifest, ctx.assertCurrent);
  capacity(
    ctx,
    ctx.inputs.stores.map(({ original, image }) => ({
      path: original.path,
      size: fs.statSync(image).size,
    })),
  );
}

async function privateMigrate(ctx: Context, index: number) {
  ctx.phase = "private migrate";
  const prefix = path.join(storeDirectory(ctx, index), "working-");
  const recorded = manifest(ctx).artifacts.find((file) => file.path.startsWith(prefix));
  const file = recorded?.path ?? `${prefix}${randomUUID()}.sqlite`;
  if (recorded) {
    await assertDatabaseArtifact(recorded);
    return file;
  }
  await createVerifiedSqliteSnapshot({
    sourcePath: storeAt(ctx, index).input.image,
    targetPath: file,
    preserveRowIds: true,
  });
  await runWorkboardPortTask({ operation: "migrate", sourcePath: file }, ctx);
  syncDatabasePortPath(file);
  syncDatabasePortPath(path.dirname(file));
  manifest(ctx).artifacts.push(await captureDatabaseArtifact(file));
  revise(ctx);
  return file;
}
async function stageMaterialize(ctx: Context, index: number, config: OpenClawConfig) {
  const current = manifest(ctx),
    { target } = storeAt(ctx, index);
  ctx.target = livePath(target);
  if (target.verification) {
    return;
  }
  const working = await privateMigrate(ctx, index);
  ctx.phase = "stage/materialize";
  const result = await runWorkboardPortTask(
    {
      operation: "stage",
      sourcePath: working,
      targetPath: stagePath(ctx, index),
      to: current.direction.to,
      storeId: target.storeId,
      namespace: target.intended.engine === "postgres" ? target.intended.namespace : "",
      config: postgresConfig(config),
      resume: true,
      sourceVerification:
        current.direction.from === "postgres"
          ? JSON.parse(
              fs.readFileSync(
                path.join(storeDirectory(ctx, index), "postgres/manifest.json"),
                "utf8",
              ),
            ).verification
          : undefined,
    },
    ctx,
  );
  const proof = result.verification;
  target.verification = {
    contentHash: digest(proof.tables),
    allocationHash: digest(proof.allocations),
    catalogHash: result.descriptorHash,
    rowCount: Object.values(proof.tables).reduce((sum, table) => sum + table.rows, 0),
    ownerAdmitted: true,
  };
  current.artifacts.push(await captureDatabaseArtifact(stagePath(ctx, index)));
  await record(ctx, path.join(storeDirectory(ctx, index), "verification.json"), proof);
}
async function verify(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  original = false,
  sourcePath?: string,
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
    original && target.original.engine === "postgres" ? parsed.verification : parsed;
  const location =
    sourcePath && original && current.direction.from === "postgres"
      ? readBackupEngine(sourcePath)
      : original
        ? target.original
        : target.intended;
  await runWorkboardPortTask(
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

async function assertOriginal(ctx: Context, index: number, config: OpenClawConfig) {
  const { target, input: store } = storeAt(ctx, index);
  ctx.target = store.original.path;
  privatePaths(ctx, [store.original.path]);
  const stat = fs.lstatSync(store.original.path, { bigint: true });
  if (String(stat.dev) !== store.dev || String(stat.ino) !== store.ino) {
    refuse(ctx, "changed source identity", "captured device and inode");
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
async function classifyConfig(ctx: Context) {
  const current = await snapshot(ctx),
    files = await configInputs(ctx),
    saved = manifest(ctx);
  if (isDeepStrictEqual(files, saved.originalConfig)) {
    return { current, engine: saved.direction.from };
  }
  if (
    !isDeepStrictEqual(
      files.map((file) => file.path),
      saved.originalConfig.map((file) => file.path),
    )
  ) {
    refuse(ctx, "changed config include graph", "captured config inputs");
  }
  for (const artifact of saved.artifacts.filter((file) =>
    path.basename(file.path).startsWith("config-intent-"),
  )) {
    const intent = z
      .object({ hash: z.string(), engine: z.enum(["sqlite", "postgres"]) })
      .parse(JSON.parse(fs.readFileSync(artifact.path, "utf8")));
    if (digest(current.snapshot.sourceConfig) === intent.hash) {
      return { current, engine: intent.engine };
    }
  }
  return refuse(ctx, "unrecognized config contents", "recorded old or prepared new config");
}

async function prepareStores(ctx: Context, config: OpenClawConfig, restoring: boolean) {
  ctx.phase = restoring ? "rollback" : "prepare stores";
  const current = manifest(ctx);
  for (const [index, target] of current.targets.entries()) {
    ctx.target = livePath(target);
    privatePaths(ctx, [ctx.target]);
    const actual = await captureDatabaseArtifact(ctx.target);
    const staged = current.artifacts.find((file) => file.path === stagePath(ctx, index));
    const restored =
      actual.sha256 === target.originalCapture.sha256 ||
      current.artifacts.some(
        (file) => path.basename(file.path).startsWith("rollback-") && file.sha256 === actual.sha256,
      );
    const fresh = staged && actual.sha256 === staged.sha256;
    if (!fresh && !(restoring && restored)) {
      if (restoring && target.original.engine === "postgres") {
        await assertDatabaseArtifact(storeAt(ctx, index).input.original);
      } else {
        await assertOriginal(ctx, index, config);
      }
    }
    if (!restoring && fresh) {
      await verify(ctx, index, config);
      continue;
    }
    let source = restoring ? target.originalCapture.path : stagePath(ctx, index);
    if (restoring && target.original.engine === "postgres") {
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
    await runWorkboardPortTask({ operation: "checkpoint", sourcePath: ctx.target }, ctx);
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
async function publishStores(ctx: Context) {
  ctx.phase = "publish stores";
  const current = manifest(ctx);
  ctx.target = ctx.prepared[0]?.[0] ?? ctx.configPath;
  if (current.state === "preparing") {
    current.state = "publishing";
    revise(ctx);
  }
  for (const [target, image] of ctx.prepared) {
    ctx.target = target;
    await image.publish();
  }
}

async function switchConfig(ctx: Context, restoring: boolean) {
  ctx.phase = "switch config";
  ctx.target = ctx.configPath;
  const { current, engine } = await classifyConfig(ctx),
    saved = manifest(ctx);
  const wanted = restoring ? saved.direction.from : saved.direction.to;
  const value = restoring ? (ctx.inputs!.originalEngine ?? undefined) : wanted;
  if (engine !== wanted) {
    const candidate = structuredClone(
      current.snapshot.authoredConfig ?? current.snapshot.sourceConfig,
    );
    const unsetEngine = value === undefined;
    setConfigValueAtPath(candidate, ["database", "engine"], value);
    const result = await writeConfigFile(candidate, {
      ...current.writeOptions,
      baseSnapshot: current.snapshot,
      inputBase: "source",
      explicitSetPaths: unsetEngine ? [] : [["database", "engine"]],
      unsetPaths: unsetEngine ? [["database", "engine"]] : undefined,
      assertCurrent: ctx.assertCurrent,
      observe: false,
      skipOutputLogs: true,
      skipRuntimeSnapshotRefresh: true,
      beforeCommit: async () => {
        await publishStores(ctx);
        ctx.phase = "switch config";
        ctx.target = ctx.configPath;
      },
      preCommitRuntimePreflight: async (source) => {
        await record(ctx, path.join(ctx.directory, `config-intent-${randomUUID()}.json`), {
          hash: digest(source),
          engine: wanted,
        });
      },
    });
    if (!(await configInputs(ctx)).some((file) => file.sha256 === result.persistedHash)) {
      refuse(ctx, "config receipt hash mismatch", "writer's persisted hash");
    }
  } else {
    await publishStores(ctx);
  }
  for (const file of saved.originalConfig) {
    ctx.assertCurrent();
    syncDatabasePortPath(file.path);
    syncDatabasePortPath(path.dirname(file.path));
  }
}
function finalize(ctx: Context, outcome: "ported" | "rolled-back") {
  ctx.phase = "finalize/archive";
  const current = manifest(ctx);
  if (current.state !== "complete") {
    current.state = "complete";
    current.outcome = outcome;
    revise(ctx);
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
    backup: ctx.directory,
    remainingSqlite: ctx.inputs?.remainingSqlite ?? [],
    manifest: archived,
    serverCapacity: "unknown; former PostgreSQL namespaces retained",
    restart: "Start the Gateway through its service owner.",
  };
}
async function resume(ctx: Context) {
  const current = manifest(ctx),
    config = (await snapshot(ctx)).snapshot.config;
  if (current.state === "preparing") {
    for (const input of current.originalConfig) {
      await assertDatabaseArtifact(input);
    }
    for (const index of current.targets.keys()) {
      await stageMaterialize(ctx, index, config);
    }
  }
  return await finishPort(ctx, config, false);
}
async function rollback(ctx: Context) {
  const engine = resolveConfigEnvVars(ctx.inputs!.originalEngine, ctx.env) ?? "sqlite";
  if (engine !== manifest(ctx).direction.from) {
    refuse(ctx, "changed engine environment", "original engine environment before rollback");
  }
  return await finishPort(ctx, (await snapshot(ctx)).snapshot.config, true);
}
async function finishPort(ctx: Context, config: OpenClawConfig, restoring: boolean) {
  try {
    const preparingRollback = restoring && manifest(ctx).state === "preparing";
    if (preparingRollback) {
      for (const index of manifest(ctx).targets.keys()) {
        await assertOriginal(ctx, index, config);
      }
    } else {
      await prepareStores(ctx, config, restoring);
    }
    await withConfigWriteLock(
      ctx.configPath,
      async () => {
        if (preparingRollback) {
          await classifyConfig(ctx);
        } else {
          await switchConfig(ctx, restoring);
        }
      },
      ctx.env,
      ctx.assertCurrent,
    );
  } finally {
    for (const [, image] of ctx.prepared) {
      await image.cleanup();
    }
  }
  return finalize(ctx, restoring ? "rolled-back" : "ported");
}
async function loadRecovery(ctx: Context) {
  const saved = manifest(ctx);
  ctx.directory = path.join(
    path.dirname(databasePortManifestPath(ctx.stateDir)),
    saved.operationId,
  );
  for (const file of saved.artifacts) {
    if (!file.path.startsWith(`${ctx.directory}${path.sep}`)) {
      refuse(ctx, "artifact outside operation directory", "private operation-owned artifacts");
    }
    privatePaths(ctx, [file.path]);
    const stat = fs.lstatSync(file.path);
    if ((stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      refuse(ctx, "nonprivate artifact", "0600 caller-owned file");
    }
    await assertDatabaseArtifact(file);
  }
  ctx.inputs = inputsSchema.parse(
    JSON.parse(fs.readFileSync(path.join(ctx.directory, "inputs.json"), "utf8")),
  );
  if (
    ctx.inputs.stores.length !== saved.targets.length ||
    saved.targets.some((target, index) => {
      const file = ctx.inputs?.stores[index]?.original.path;
      return !file?.startsWith(`${ctx.stateDir}${path.sep}`) || file !== livePath(target);
    })
  ) {
    refuse(ctx, "mismatched target set", "complete captured store set");
  }
}

export async function doctorDatabasePort(options: DatabasePortOptions) {
  const stateDir = path.resolve(resolveStateDir()),
    configPath = path.resolve(resolveConfigPath());
  const ctx: Context = {
    stateDir,
    configPath,
    env: process.env,
    assertCurrent: () => {},
    phase: "preflight",
    target: stateDir,
    directory: "",
    prepared: [],
  };
  try {
    privatePaths(ctx, [stateDir, configPath]);
    if (hasActiveGatewayStateOwner(path.join(stateDir, "state", "openclaw.sqlite"))) {
      refuse(ctx, "hosted Gateway owner", "exclusive offline custody");
    }
    const recoveryPath = options.resume ?? options.rollback;
    const recovery = recoveryPath
      ? {
          manifestPath: path.resolve(recoveryPath),
          operationId: z
            .object({ operationId: z.uuid() })
            .parse(JSON.parse(fs.readFileSync(recoveryPath, "utf8"))).operationId,
          action: options.rollback ? ("rollback" as const) : ("resume" as const),
        }
      : undefined;
    return await runWithLocalStateOwner({
      method: "database.port",
      params: {},
      target: stateDir,
      onForeignOwner: "refuse",
      databasePortRecovery: recovery,
      runLocal: async ({ env, assertCurrent, signal }) => {
        Object.assign(ctx, { env, assertCurrent, signal });
        if (recovery) {
          ctx.manifest = assertDatabasePortRecoveryAllowed(stateDir, recovery);
          await loadRecovery(ctx);
          if (ctx.manifest.state === "complete") {
            return finalize(ctx, ctx.manifest.outcome!);
          }
          return recovery.action === "resume" ? await resume(ctx) : await rollback(ctx);
        }
        const facts = await preflight(ctx, options);
        if (options.dryRun || facts.from === facts.to || !facts.stores.length) {
          return {
            phase: options.dryRun ? "preflight" : "complete",
            engine: facts.from,
            to: facts.to,
            stores: facts.stores,
            migrations: facts.migrations,
            remainingSqlite: facts.remainingSqlite,
            verification: options.dryRun
              ? `${facts.migrations.length} stores need private migration; copy and privilege probe not performed`
              : "verified no-op",
            serverCapacity: "unknown",
          };
        }
        await captureOriginals(ctx, facts);
        return await resume(ctx);
      },
    });
  } catch (error) {
    if (error instanceof WorkboardPortError) {
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
}
