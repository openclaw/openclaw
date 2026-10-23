import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { resolveDaemonRuntimePinStorePath } from "../daemon/runtime-pin-store.js";
import { listDefaultAgentDatabasePaths } from "../state/agent-database-path-discovery.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
} from "../state/openclaw-state-maintenance-context.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import type { ClientCredentialRehearsalBinding } from "./client-credential-restore-contract.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { resolveStatePortRoots } from "./database-engine/state-port.js";
import { resolveUserPath } from "./home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  retainSnapshotWork,
  withPreparedSqliteSnapshot,
} from "./sqlite-readonly-location-cleanup.js";
import {
  inspectSqliteSchemaHeaderInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import {
  StateDatabaseDiscoverySchema,
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  queueStateDatabaseSpelling,
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
  type StateDatabaseDiscovery,
  type UpdateStateDatabaseOwner,
} from "./update-candidate-paths.js";
import {
  UpdateCandidatePluginCodeLinkReceiptSchema,
  sealUpdateCandidatePluginCodeLinks,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";
import {
  createUpdateStateSnapshotReporter,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { withStateInspectionCleanup } from "./update-candidate-state.process.js";
import {
  collectRegisteredPaths,
  collectSupplementalStateDatabasePaths,
  readSharedDatabaseVersion,
  readUpdateStoreSchemaVersion,
  type StateInput,
} from "./update-candidate-state.shared.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
  updateStateDatabaseExists,
} from "./update-candidate-state.sizes.js";
import {
  publishStateDatabaseVersions,
  UpdateStateSchemaVersionsSchema,
  type UpdateStateSchemaVersion,
} from "./update-candidate-state.versions.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

export type { UpdateStateSchemaVersion } from "./update-candidate-state.versions.js";
export const UpdateCandidateStateSnapshotSchema = z.object({
  versions: UpdateStateSchemaVersionsSchema,
  pluginPaths: z.record(z.string(), z.string()),
  pluginCodeLinks: UpdateCandidatePluginCodeLinkReceiptSchema.optional(),
});
const leaseTables = ["agent_database_leases", "state_leases"] as const;
type CandidateStateDatabase = Pick<DB, "agent_databases" | (typeof leaseTables)[number]>;

export const UpdateCandidateSnapshotInventorySchema = z.object({
  databases: z
    .array(z.tuple([z.string(), StateDatabaseDiscoverySchema]))
    .transform((entries) => new Map(entries)),
  pluginBytes: z.number().nonnegative(),
  pluginPlan: z.literal(UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME),
  // The installed driver budgets the candidate worker's copy lifecycle.
  // Omission retains the larger allowance used by released older workers.
  snapshotSpace: z.literal("single-generation").optional(),
  // Published candidate workers before named snapshot warnings omit this field.
  warnings: z.array(z.string()).default([]),
});
export const UpdateStateSchemaInspectionPlanSchema = z.object({
  files: z.array(z.tuple([z.string(), StateDatabaseDiscoverySchema])),
  sharedVersion: UpdateStateSchemaVersionsSchema.element,
});
type UpdateStateSchemaInspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

async function withStateDatabaseSnapshot<T>(
  file: string,
  read: (location: string) => T | Promise<T>,
  stagingRoot?: string,
  onProgress?: (progress: UpdateStateInspectionProgress) => void,
  preserveSourceArtifacts = false,
): Promise<T> {
  const progress = createUpdateStateSnapshotReporter(file, "shared database snapshot", onProgress);
  const snapshot = preserveSourceArtifacts
    ? prepareSqliteReadOnlyLocationSyncInProcess(file, stagingRoot)
    : await prepareSqliteReadOnlyLocationInProcess(
        file,
        stagingRoot,
        undefined,
        progress.onProgress,
      );
  return withPreparedSqliteSnapshot(snapshot, async (location) => {
    progress.complete((await fs.stat(location)).size);
    return read(location);
  });
}

export async function collectStateDatabasePaths(
  input: StateInput,
  options: { includeUnconfiguredAgents?: boolean } = {},
): Promise<Map<string, StateDatabaseDiscovery>> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  // Every discovery source queues one projection identity per database: with an
  // extended-length state root, directory enumeration and a registry
  // registration spell the same file differently, and queuing both copies
  // breaks the snapshot with a duplicate destination. Each identity keeps
  // every raw spelling so the published versions response matches the mixed
  // alias baselines released updaters captured.
  const stateRoot = path.resolve(input.stateDir);
  const files = new Map<string, StateDatabaseDiscovery>();
  const queue = (file: string, owner?: UpdateStateDatabaseOwner) => {
    queueStateDatabaseSpelling(files, stateRoot, file, owner);
  };
  queue(shared, { role: "global" });
  for (const file of resolveStatePortRoots({ ...input, env: input.env ?? process.env })) {
    // Only the selected installation owns the published global recovery identity.
    // Retained custom roots use the existing exact, opaque capture contract.
    if (file !== shared && (await updateStateDatabaseExists(file))) {
      queue(file);
    }
  }
  // Published owners describe shared/agent schemas; local stores retain exact opaque contents.
  queue(resolveClientCredentialStorePath({ OPENCLAW_STATE_DIR: stateRoot }));
  queue(resolveDaemonRuntimePinStorePath({ OPENCLAW_STATE_DIR: stateRoot }));
  const directories =
    options.includeUnconfiguredAgents !== false
      ? (await listDefaultAgentDatabasePaths(input.stateDir)).map((entry) => entry.agentId)
      : [];
  const configured = Object.entries(input.config.agents?.entries ?? {});
  for (const directory of [input.env?.OPENCLAW_AGENT_DIR, input.env?.PI_CODING_AGENT_DIR]) {
    if (directory?.trim()) {
      queue(path.join(resolveUserPath(directory, input.env), "openclaw-agent.sqlite"));
    }
  }
  const projected = (input.config.agents?.list ?? []).map((agent) => [agent.id, agent] as const);
  for (const [id, agent] of [...configured, ...projected]) {
    directories.push(id);
    if (agent.agentDir) {
      queue(path.join(resolveUserPath(agent.agentDir, input.env), "openclaw-agent.sqlite"), {
        role: "agent",
        agentId: id,
      });
    }
  }
  for (const id of new Set(["main", ...directories])) {
    queue(path.resolve(input.stateDir, "agents", id, "agent", "openclaw-agent.sqlite"), {
      role: "agent",
      agentId: id,
    });
  }
  return new Map(
    [...files.entries()].toSorted(([, a], [, b]) =>
      a.spellings[0] < b.spellings[0] ? -1 : a.spellings[0] > b.spellings[0] ? 1 : 0,
    ),
  );
}

/** Read registrations and plugin ownership from one private shared copy before budgeting. */
export async function readUpdateCandidateStateInventoryInProcess(
  input: StateInput & {
    targetStateDir: string;
    candidateRoot: string;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<z.infer<typeof UpdateCandidateSnapshotInventorySchema>> {
  await fs.mkdir(input.targetStateDir, { recursive: true, mode: 0o700 });
  const planPath = path.join(input.targetStateDir, UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME);
  await fs.writeFile(planPath, "", { mode: 0o600, flag: "wx" });
  let progressAt = Date.now();
  const onProgress = async () => {
    const now = Date.now();
    if (now - progressAt < 1000) {
      return;
    }
    progressAt = now;
    await fs.utimes(planPath, new Date(now), new Date(now));
  };
  const { prepareUpdateCandidatePlugins } = await import("./update-candidate-plugins.js");
  const files = await collectSupplementalStateDatabasePaths(
    input,
    await collectStateDatabasePaths(input),
  );
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const measure = async (
    sharedStateDatabasePath?: string,
    sharedStatePluginIndex?: import("./update-candidate-plugins.js").UpdateCandidatePluginIndex,
  ): Promise<z.infer<typeof UpdateCandidateSnapshotInventorySchema>> => {
    // Database discovery is complete; plugin failures must retain their own phase.
    input.onProgress?.({ phase: "plugin inventory", path: input.stateDir });
    const plugins = await prepareUpdateCandidatePlugins({
      ...input,
      sharedStateDatabasePath,
      sharedStatePluginIndex,
      onProgress,
    });
    await fs.writeFile(planPath, JSON.stringify(plugins));
    return {
      databases: files,
      pluginBytes: plugins.bytes,
      pluginPlan: UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
      warnings: plugins.warnings,
    };
  };
  if (await updateStateDatabaseExists(shared)) {
    if (resolveDatabaseFamilyEngines(input.config).state === "postgres") {
      const { readUpdatePostgresState } = await import("./update-candidate-state.postgres.js");
      const result = await readUpdatePostgresState(input, files);
      for (const [identity, discovery] of result.files) {
        files.set(identity, discovery);
      }
      return measure(undefined, result.pluginIndex);
    }
    return withStateDatabaseSnapshot(
      shared,
      async (location) => {
        const db = openNodeSqliteDatabase(location, { readOnly: true });
        try {
          collectRegisteredPaths(db, shared, files);
        } finally {
          db.close();
        }
        return measure(location);
      },
      input.targetStateDir,
      input.onProgress,
    );
  }
  return measure();
}

/** Discover registered stores from the same private shared-database generation used for inspection. */
export async function discoverUpdateStateSchemaInspectionInProcess(
  input: StateInput & {
    stagingRoot: string;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
    preserveSourceArtifacts?: boolean;
  },
): Promise<UpdateStateSchemaInspectionPlan> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  input.onProgress?.({ phase: "shared database discovery", path: shared });
  const files = await collectSupplementalStateDatabasePaths(
    input,
    await collectStateDatabasePaths(input),
  );
  if (!(await updateStateDatabaseExists(shared))) {
    return { files: [...files], sharedVersion: { path: shared, userVersion: null } };
  }
  if (resolveDatabaseFamilyEngines(input.config).state === "postgres") {
    const { readUpdatePostgresState } = await import("./update-candidate-state.postgres.js");
    const result = await readUpdatePostgresState(input, files);
    return { files: result.files, sharedVersion: { path: shared, ...result.version } };
  }
  const sharedVersion = await withStateDatabaseSnapshot(
    shared,
    async (location) => ({
      path: shared,
      ...(await readSharedDatabaseVersion(location, shared, files, input)),
    }),
    input.stagingRoot,
    input.onProgress,
    input.preserveSourceArtifacts,
  );
  return { files: [...files], sharedVersion };
}

/** Missing databases stay explicit so creation is schema-checked and loss blocks rollback. */
export async function readUpdateStateSchemaVersionsInProcess(
  input: StateInput & {
    inspectionPlan?: UpdateStateSchemaInspectionPlan;
    stagingRoot?: string;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
    preserveSourceArtifacts?: boolean;
  },
): Promise<UpdateStateSchemaVersion[]> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = input.inspectionPlan
    ? new Map(input.inspectionPlan.files)
    : await collectSupplementalStateDatabasePaths(input, await collectStateDatabasePaths(input));
  const sharedIdentity = resolveUpdateCandidateStateIdentity(input.stateDir, shared);
  // Inspect each identity once, then publish every spelling for released rollback baselines.
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  for (const [identity, discovery] of files) {
    const file = discovery.spellings[0];
    if (identity === sharedIdentity && input.inspectionPlan) {
      const { path: _path, ...version } = input.inspectionPlan.sharedVersion;
      inspected.set(identity, version);
      continue;
    }
    input.onProgress?.({
      phase:
        file === shared
          ? "shared database inspection"
          : file === resolveClientCredentialStorePath({ OPENCLAW_STATE_DIR: input.stateDir })
            ? "client credential schema inspection"
            : file === resolveDaemonRuntimePinStorePath({ OPENCLAW_STATE_DIR: input.stateDir })
              ? "daemon schema inspection"
              : "agent schema inspection",
      path: file,
    });
    // Missing stores stay explicit so creation is checked and loss blocks rollback.
    if (!(await updateStateDatabaseExists(file))) {
      inspected.set(identity, { userVersion: null });
      continue;
    }
    if (file === shared && resolveDatabaseFamilyEngines(input.config).state === "postgres") {
      const { readUpdatePostgresState } = await import("./update-candidate-state.postgres.js");
      const result = await readUpdatePostgresState(input, files);
      for (const [key, entry] of result.files) {
        files.set(key, entry);
      }
      inspected.set(identity, result.version);
      continue;
    }
    if (file !== shared) {
      inspected.set(identity, await readUpdateStoreSchemaVersion(file, input));
      continue;
    }
    inspected.set(
      identity,
      await withStateDatabaseSnapshot(
        file,
        (location) => readSharedDatabaseVersion(location, shared, files, input),
        input.stagingRoot,
        input.onProgress,
        input.preserveSourceArtifacts,
      ),
    );
  }
  return publishStateDatabaseVersions(files, inspected, input);
}

/** Released candidates can snapshot shared state even when they cannot expose discovery. */
async function discoverLegacyUpdateStateSchemaInspection(
  params: Parameters<typeof runUpdateStateInspectionWorker>[0],
): Promise<UpdateStateSchemaInspectionPlan> {
  params.signal?.throwIfAborted();
  const shared = path.resolve(params.input.stateDir, "state", "openclaw.sqlite");
  const files = await collectStateDatabasePaths(params.input);
  if (!(await updateStateDatabaseExists(shared))) {
    return { files: [...files], sharedVersion: { path: shared, userVersion: null } };
  }
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    params.stagingRoot,
    params.root !== undefined,
    params.signal,
  );
  // Settle the copy worker and close the private reader before removing discovery staging.
  return withStateInspectionCleanup(stagingRoot, async () => {
    // The selected candidate owns source access; the loaded parent only opens its private copy.
    const snapshot = parseUpdateStateInspectionWorker(
      await runUpdateStateInspectionWorker({ ...params, stagingRoot, readOnlySource: shared }),
      z.object({ ok: z.literal(true), location: z.string() }),
    );
    const relative = path.relative(stagingRoot, snapshot.location);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Legacy state inspection returned a snapshot outside parent-owned staging.");
    }
    const sharedVersion = {
      path: shared,
      ...(await readSharedDatabaseVersion(snapshot.location, shared, files, params.input)),
    };
    return { files: [...files], sharedVersion };
  });
}

async function discoverStateSchema(params: Parameters<typeof runUpdateStateInspectionWorker>[0]) {
  const result = await runUpdateStateInspectionWorker(params);
  const legacyWorker =
    result.code !== 0 && result.stderr.includes("Unknown update state inspection mode");
  const discovery = legacyWorker
    ? await discoverLegacyUpdateStateSchemaInspection(params)
    : parseUpdateStateInspectionWorker(result, UpdateStateSchemaInspectionPlanSchema);
  return { discovery, legacyWorker };
}

/** Pre-migration inventory reads raw registrations without admitting the source schema. */
export async function readUpdateStateDatabaseInventory(input: StateInput) {
  const sourceEnv = input.env ?? process.env;
  const stagingParent = resolvePrivateSqliteSnapshotStagingRoot(sourceEnv);
  const stagingRoot = await createSqliteSnapshotStagingDirectory(stagingParent);
  return withStateInspectionCleanup(stagingRoot, async () => {
    const worker = { nodeRunner: process.execPath, sourceEnv, stagingRoot };
    const shared = path.join(input.stateDir, "state", "openclaw.sqlite");
    const { discovery } = await discoverStateSchema({
      ...worker,
      input: { ...input, mode: "discover", stagingRoot },
      databases: await readUpdateStateDatabaseSizes([shared], worker),
    });
    return new Map(discovery.files);
  });
}

/** Raw fingerprint reads need their own process so descriptor closes cannot release caller locks. */
export async function readUpdateDatabaseGenerationsIsolated(
  paths: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    acquisition?: UpdateRecoveryCaptureAcquisition;
    retryAdvice?: boolean;
    pluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
  } = {},
): Promise<UpdateDatabaseGenerations> {
  const scope = getOpenClawDatabaseMaintenanceScope();
  const maintenanceOwner =
    options.acquisition?.mode === "maintenance-owner" &&
    paths.every((pathname) => maintenanceOwnerHasSourceCustody(scope, pathname));
  const { root, timeoutMs, env: sourceEnv = process.env, signal: caller } = options;
  const controller = new AbortController();
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(sourceEnv),
    root !== undefined,
    signal,
  );
  const inspection = withStateInspectionCleanup(stagingRoot, async () => {
    const worker = { nodeRunner: process.execPath, sourceEnv, stagingRoot, timeoutMs, signal };
    const generations = parseUpdateStateInspectionWorker(
      await runUpdateStateInspectionWorker({
        ...worker,
        root,
        retryAdvice: options.retryAdvice,
        sources: paths,
        ...(maintenanceOwner ? { ioBudget: "deadline" as const } : {}),
        input: {
          mode: "database-generations",
          paths,
          ...(options.pluginOwners ? { pluginOwners: options.pluginOwners } : {}),
          stateDir: resolveStateDir(sourceEnv),
          config: {},
        },
        databases: maintenanceOwner
          ? await readUpdateStateDatabaseSizesInProcess(paths, signal)
          : await readUpdateStateDatabaseSizes(paths, worker),
      }),
      z.record(z.string(), z.nullable(z.string().regex(/^[a-f0-9]{64}$/u))),
    );
    if (
      Object.keys(generations).length !== new Set(paths).size ||
      paths.some((pathname) => !Object.hasOwn(generations, pathname))
    ) {
      throw new Error("Database generation worker did not return the supplied inventory.");
    }
    return generations;
  });
  return retainSnapshotWork(inspection, () => controller.abort());
}

/** Schema fencing reads private copies in candidate workers under size-aware deadlines. */
export async function readUpdateStateSchemaVersions({
  root,
  nodeRunner = process.execPath,
  timeoutMs,
  signal: callerSignal,
  onInventory,
  ...input
}: StateInput & {
  // Omit only before activation; null forbids falling back after an uncertain swap.
  root?: string | null;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  preserveSourceArtifacts?: boolean;
  onInventory?: (files: ReadonlyMap<string, StateDatabaseDiscovery>) => void;
}): Promise<UpdateStateSchemaVersion[]> {
  if (root === null) {
    throw new Error("The active installation root is unknown; state inspection is unsafe.");
  }
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const sourceEnv = input.env ?? process.env;
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(sourceEnv),
    root !== undefined,
    signal,
  );
  const inspection = withStateInspectionCleanup(stagingRoot, async () => {
    const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
    const sizeOptions = { nodeRunner, signal, sourceEnv, stagingRoot, timeoutMs };
    const discoveryParams = {
      input: { ...input, mode: "discover", stagingRoot },
      nodeRunner,
      root,
      signal,
      sourceEnv,
      stagingRoot,
      timeoutMs,
      databases: await readUpdateStateDatabaseSizes([shared], sizeOptions),
    };
    // Activation may replace the updater package. Both legacy subprocesses must use the candidate.
    const { discovery, legacyWorker } = await discoverStateSchema(discoveryParams);
    onInventory?.(new Map(discovery.files));
    const sharedIdentity = resolveUpdateCandidateStateIdentity(input.stateDir, shared);
    // Legacy workers recopy the shared database and may inspect every raw alias.
    // Current workers reuse the discovered shared version and inspect each remaining identity once.
    const files = legacyWorker
      ? discovery.files.flatMap(([, database]) => database.spellings)
      : discovery.files
          .filter(([identity]) => identity !== sharedIdentity)
          .map(([, database]) => database.spellings[0]);
    return parseUpdateStateInspectionWorker(
      await runUpdateStateInspectionWorker({
        ...discoveryParams,
        input: legacyWorker
          ? { ...input, mode: "versions" }
          : { ...input, mode: "versions", stagingRoot, inspectionPlan: discovery },
        databases: await readUpdateStateDatabaseSizes(files, sizeOptions),
      }),
      UpdateStateSchemaVersionsSchema,
    );
  });
  return retainSnapshotWork(inspection, () => controller.abort());
}

/** Keep snapshot dependencies out of schema inspection; rebind registry paths to private copies. */
export async function snapshotUpdateCandidateState(
  input: StateInput & {
    targetStateDir: string;
    candidateRoot: string;
    pluginPlanPath: string;
    databaseInventory: string[];
    fullIntegrityCheck?: boolean;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<z.infer<typeof UpdateCandidateStateSnapshotSchema>> {
  const { createVerifiedSqliteSnapshot } = await import("./sqlite-snapshot.js");
  const { copyUpdateCandidatePlugins, UpdateCandidatePluginPlanSchema } =
    await import("./update-candidate-plugins.js");
  const plugins = UpdateCandidatePluginPlanSchema.parse(
    JSON.parse(await fs.readFile(input.pluginPlanPath, "utf8")),
  );
  const admittedDatabases = new Set(input.databaseInventory);
  const sourceRoot = path.resolve(input.stateDir);
  const shared = path.join(sourceRoot, "state", "openclaw.sqlite");
  const localCredentials = resolveClientCredentialStorePath({ OPENCLAW_STATE_DIR: sourceRoot });
  const { readClientCredentialFileIdentity } = await import("./client-credential-receipt.js");
  let copiedShared: Omit<ClientCredentialRehearsalBinding, "localPath"> | undefined;
  let copiedCredentials: string | undefined;
  const { createUpdateCandidateExecApprovalsProjection } =
    await import("./update-candidate-exec-approvals.js");
  const targetPath = (source: string) =>
    path.join(
      resolveUpdateCandidateStatePath(sourceRoot, input.targetStateDir, path.dirname(source)),
      path.basename(source),
    );
  const execApprovals = createUpdateCandidateExecApprovalsProjection(sourceRoot, targetPath);
  // Physical copies dedupe on projection identity; the published versions
  // keep every raw alias so released rollback baselines still match.
  const files = await collectSupplementalStateDatabasePaths(
    input,
    await collectStateDatabasePaths(input),
  );
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  if (
    resolveDatabaseFamilyEngines(input.config).state === "postgres" &&
    (await updateStateDatabaseExists(shared))
  ) {
    const { readUpdatePostgresState } = await import("./update-candidate-state.postgres.js");
    const discovered = await readUpdatePostgresState(input, files);
    for (const [identity, discovery] of discovered.files) {
      files.set(identity, discovery);
    }
  }
  for (const [identity, discovery] of files) {
    if (!admittedDatabases.has(identity)) {
      throw new Error(
        `State database registration changed after snapshot inventory: ${discovery.spellings[0]}`,
      );
    }
    const file = discovery.spellings[0];
    if (!(await updateStateDatabaseExists(file))) {
      inspected.set(identity, { userVersion: null });
      continue;
    }
    const target = targetPath(file);
    const sourceSharedFile = file === shared ? readClientCredentialFileIdentity(file) : null;
    let contentVersion: number | undefined;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const progress = createUpdateStateSnapshotReporter(file, "database snapshot", input.onProgress);
    let snapshotSource = file;
    const { capturePostgresBackup, readBackupEngine } =
      await import("../snapshot/database-backup.js");
    const { userVersion } = await inspectSqliteSchemaHeaderInProcess(file, input.targetStateDir);
    // PostgreSQL anchors have header version zero; versioned SQLite uses online backup directly.
    const engine = userVersion === 0 ? readBackupEngine(file) : undefined;
    if (engine?.engine === "postgres") {
      const directory = `${target}.postgres`;
      await capturePostgresBackup({
        sourcePath: file,
        directory,
        config: input.config,
        profile: "exact",
        assertCurrent() {},
      });
      // Rehearsal owns this portable image; the source engine never changes.
      snapshotSource = path.join(directory, "database.sqlite");
    }
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath: snapshotSource,
      targetPath: target,
      sourceAcquisition: { mode: "isolated-process", stagingRoot: input.targetStateDir },
      integrity:
        snapshotSource === file
          ? {
              check: input.fullIntegrityCheck ? "full" : "quick",
              tables:
                file === shared
                  ? ["migration_sources", ...leaseTables, "agent_databases"]
                  : undefined,
            }
          : undefined,
      // The rehearsal is private and disposable; compaction would create another
      // full image and alter implicit row IDs before candidate migrations run.
      preserveRowIds: true,
      onProgress: progress.onProgress,
      ...(file === shared
        ? {
            transform: (db: DatabaseSync) => {
              contentVersion = readStateSchemaContentVersion(db);
              const queries = getNodeSqliteKysely<CandidateStateDatabase>(db);
              execApprovals.rebaseReceipt(db);
              // Source process leases cannot own the independently opened rehearsal copy.
              for (const table of leaseTables) {
                if (tableExists(db, table)) {
                  executeSqliteQuerySync(db, queries.deleteFrom(table));
                }
              }
              for (const { stored, source } of collectRegisteredPaths(db, shared, files)) {
                const rebound = targetPath(source);
                const reboundStored = path.relative(input.targetStateDir, rebound);
                const resolvedRebound = resolveOpenClawRegisteredAgentDatabasePath(
                  shared,
                  reboundStored,
                );
                // Extended-length \\?\ and plain spellings of one registered database
                // are the same duplicate pair as a legacy absolute/relative pair.
                const sameRegisteredDatabase =
                  source === resolvedRebound ||
                  (process.platform === "win32" &&
                    normalizeWindowsPathPreservingCase(source) ===
                      normalizeWindowsPathPreservingCase(resolvedRebound));
                if (stored !== reboundStored && sameRegisteredDatabase) {
                  // A legacy absolute/relative pair names exactly the same source.
                  // Collapse only that duplicate in the copy before its unique-key update.
                  executeSqliteQuerySync(
                    db,
                    queries
                      .deleteFrom("agent_databases")
                      .where("path", "=", stored)
                      .where(
                        "agent_id",
                        "in",
                        queries
                          .selectFrom("agent_databases")
                          .select("agent_id")
                          .where("path", "=", reboundStored),
                      ),
                  );
                }
                executeSqliteQuerySync(
                  db,
                  queries
                    .updateTable("agent_databases")
                    .set({ path: reboundStored })
                    .where("path", "=", stored),
                );
              }
            },
          }
        : {}),
    });
    progress.complete((await fs.stat(target)).size);
    inspected.set(identity, {
      userVersion: snapshot.userVersion,
      ...(contentVersion === undefined ? {} : { contentVersion }),
    });
    if (sourceSharedFile) {
      copiedShared = {
        sourceSharedFile,
        sourceStateRoot: sourceRoot,
        sharedPath: target,
        ...(engine?.engine === "postgres"
          ? { postgresStoreId: engine.storeId, postgresExportDirectory: `${target}.postgres` }
          : {}),
      };
    }
    if (file === localCredentials) {
      copiedCredentials = target;
    }
  }
  if (copiedShared && copiedCredentials) {
    const { rebindRehearsalClientCredentials } = await import("./client-credential-restore.js");
    rebindRehearsalClientCredentials({ ...copiedShared, localPath: copiedCredentials });
  }
  input.onProgress?.({ phase: "execution approvals snapshot", path: sourceRoot });
  await execApprovals.copySources();
  const versions = publishStateDatabaseVersions(files, inspected, input);
  const pluginCodeLinks: UpdateCandidatePluginCodeLink[] = [];
  input.onProgress?.({ phase: "plugin snapshot", path: sourceRoot });
  const pluginPaths = await copyUpdateCandidatePlugins(plugins, {
    ...input,
    onCodeLink: (fact) => pluginCodeLinks.push(fact),
  });
  return {
    versions,
    pluginPaths,
    pluginCodeLinks: await sealUpdateCandidatePluginCodeLinks(
      input.pluginPlanPath,
      pluginCodeLinks,
    ),
  };
}
