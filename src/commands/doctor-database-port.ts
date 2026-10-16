import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { setConfigValueAtPath } from "../config/config-paths.js";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { writeConfigFile } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { withConfigWriteLock } from "../config/write-lock.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import {
  runDatabasePortTask,
  type DatabasePortInspection,
  DatabasePortError,
} from "../infra/database-engine/port-command.worker.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import {
  resolveDatabaseFamilyEngines,
  type DatabaseEngineId,
} from "../infra/database-engine/registry.js";
import {
  assertDatabasePortRecoveryAllowed,
  databasePortManifestPath,
  prepareDatabasePortDirectory,
  syncDatabasePortPath,
  writeDatabasePortArtifact,
  writeDatabasePortManifest,
  type DatabasePortManifest,
} from "../infra/database-port-recovery.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  assertDatabaseArtifact,
  captureDatabaseArtifact,
  capturePostgresBackup,
  readBackupEngine,
} from "../snapshot/database-backup.js";
import {
  assertPortSelection,
  capacity,
  configInputs,
  type Context,
  digest,
  finalize,
  inputsSchema,
  livePath,
  manifest,
  postgresConfig,
  privatePaths,
  record,
  refuse,
  revise,
  readDatabasePortConfigSnapshot,
  stagePath,
  storeAt,
  storeDirectory,
} from "./doctor-database-port-context.js";
import {
  assertOriginal,
  loadDatabasePortStateReceipt,
  prepareStores,
  publishStores,
  withDatabasePortConfigStateReceipt,
} from "./doctor-database-port-publication.js";
import {
  prepareSharedStatePortSource,
  selectDatabasePortEngine,
  withDatabasePortStateOwner,
} from "./doctor-database-port-state.js";

export type DatabasePortOptions = {
  to?: DatabaseEngineId;
  dryRun?: boolean;
  resume?: string;
  rollback?: string;
};

async function preflight(ctx: Context, options: DatabasePortOptions) {
  ctx.phase = "preflight";
  const captured = await configInputs(ctx),
    current = await readDatabasePortConfigSnapshot(ctx);
  for (const input of captured) {
    await assertDatabaseArtifact(input);
  }
  const config = current.snapshot.config;
  assertPortSelection(config, options.to);
  const from = resolveDatabaseFamilyEngines(config).state,
    to = options.to!;
  await prepareSharedStatePortSource(ctx, from, to, options.dryRun);
  const context = { stateDir: ctx.stateDir, config, env: ctx.env };
  const plugins = resolvePluginMetadataSnapshot(context);
  const roots = (
    await Promise.all(
      databasePortProviders.map(async (provider) => provider.resolveRoots({ ...context, plugins })),
    )
  ).flat();
  privatePaths(ctx, roots);
  const all = await discoverBackupDatabasePaths({ stateDir: ctx.stateDir, config, env: ctx.env });
  const stores = all.filter((file) =>
    roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
  );
  const inspected = new Map<string, DatabasePortInspection>();
  for (const file of all) {
    ctx.target = file;
    privatePaths(ctx, [file]);
    if (!stores.includes(file)) {
      if (readBackupEngine(file).engine !== "sqlite") {
        refuse(
          ctx,
          "unclassified PostgreSQL anchor",
          `registered ownership; supported families: ${databasePortProviders.map((provider) => provider.id).join(", ")}`,
        );
      }
      continue;
    }
    const facts = await runDatabasePortTask(
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
    await runDatabasePortTask(
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

async function privateMigrate(ctx: Context, index: number, config: OpenClawConfig) {
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
  await runDatabasePortTask({ operation: "migrate", sourcePath: file, config }, ctx);
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
  const working = await privateMigrate(ctx, index, config);
  ctx.phase = "stage/materialize";
  const result = await runDatabasePortTask(
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
async function classifyConfig(ctx: Context) {
  const current = await readDatabasePortConfigSnapshot(ctx),
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
    const result = await withDatabasePortConfigStateReceipt(ctx, current.snapshot.config, () =>
      writeConfigFile(candidate, {
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
          // Source reads are finished; every config publication effect now belongs to the target.
          await selectDatabasePortEngine(ctx, current.snapshot.config, wanted);
          ctx.phase = "switch config";
          ctx.target = ctx.configPath;
        },
        preCommitRuntimePreflight: async (source) => {
          await record(ctx, path.join(ctx.directory, `config-intent-${randomUUID()}.json`), {
            hash: digest(source),
            engine: wanted,
          });
        },
      }),
    );
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
async function resume(ctx: Context) {
  const current = manifest(ctx),
    config = (await readDatabasePortConfigSnapshot(ctx)).snapshot.config;
  assertPortSelection(config, current.direction.to);
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
  return await finishPort(ctx, (await readDatabasePortConfigSnapshot(ctx)).snapshot.config, true);
}
async function finishPort(ctx: Context, config: OpenClawConfig, restoring: boolean) {
  assertPortSelection(
    config,
    restoring ? manifest(ctx).direction.from : manifest(ctx).direction.to,
  );
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
      // Configured and retained agents can live outside the state root. The
      // verified private input must still name its manifest-bound target.
      return !file || file !== livePath(target);
    })
  ) {
    refuse(ctx, "mismatched target set", "complete captured store set");
  }
  loadDatabasePortStateReceipt(ctx);
}

export async function doctorDatabasePort(options: DatabasePortOptions) {
  const stateDir = path.resolve(resolveStateDir()),
    configPath = path.resolve(resolveConfigPath());
  const ctx: Context = {
    stateDir,
    configPath,
    env: process.env,
    engineSelection: { effectiveEngines: resolveDatabaseFamilyEngines({}) },
    assertCurrent: () => {},
    phase: "preflight",
    target: stateDir,
    directory: "",
    prepared: [],
  };
  try {
    privatePaths(ctx, [stateDir, configPath]);
    assertPortSelection((await readDatabasePortConfigSnapshot(ctx)).snapshot.config);
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
    return await withDatabasePortStateOwner(ctx, recovery, async () => {
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
    });
  } catch (error) {
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
}
