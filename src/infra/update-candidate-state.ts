import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { resolveUserPath } from "./home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode, normalizeWindowsPathPreservingCase } from "./path-guards.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  createSqliteSnapshotStagingDirectory,
  inspectSqliteSchemaHeaderInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  removeTempDirectory,
} from "./sqlite-readonly-location.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

const UpdateStateSchemaVersionsSchema = z.array(
  z.object({
    path: z.string(),
    userVersion: z.number().nullable(),
    contentVersion: z.number().optional(),
  }),
);
export type UpdateStateSchemaVersion = z.infer<typeof UpdateStateSchemaVersionsSchema>[number];
export const UpdateCandidateStateSnapshotSchema = z.object({
  versions: UpdateStateSchemaVersionsSchema,
  pluginPaths: z.record(z.string(), z.string()),
});
type StateInput = { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv };
type CandidateStateDatabase = Pick<
  DB,
  "agent_databases" | "agent_database_leases" | "state_leases"
>;

/** Older inspection workers report only the published version; agent stores never defer it. */
export function resolveUpdateStateContentVersion(entry: UpdateStateSchemaVersion): number | null {
  return entry.contentVersion ?? entry.userVersion;
}

export function updateStateSchemaVersionsMatch(
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
  params: { sharedPath: string; candidateSchemaVersions?: OpenClawSchemaVersions },
): boolean {
  const versions = new Map(
    after.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  const candidate = params.candidateSchemaVersions;
  if (!candidate) {
    return (
      before.length === after.length &&
      before.every((entry) => versions.get(entry.path) === resolveUpdateStateContentVersion(entry))
    );
  }
  const baseline = new Map(
    before.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  return (
    before.every(
      (entry) =>
        resolveUpdateStateContentVersion(entry) === null ||
        versions.get(entry.path) === resolveUpdateStateContentVersion(entry),
    ) &&
    after.every((entry) => {
      const version = resolveUpdateStateContentVersion(entry);
      if (version === null || baseline.get(entry.path) === version) {
        return true;
      }
      // Verification can create a store for the first time. All collected paths
      // except the shared database are configured or registered agent stores.
      const supported = entry.path === params.sharedPath ? candidate.state : candidate.agent;
      return baseline.get(entry.path) == null && version === supported;
    })
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Every raw spelling discovered for one database, grouped by projection identity. */
const StateDatabaseDiscoverySchema = z.object({
  spellings: z.tuple([z.string()], z.string()),
});
type StateDatabaseDiscovery = z.infer<typeof StateDatabaseDiscoverySchema>;
export const UpdateCandidateStateInventorySchema = z
  .array(z.tuple([z.string(), StateDatabaseDiscoverySchema]))
  .transform((entries) => new Map(entries));
export const UpdateCandidateSnapshotInventorySchema = z.object({
  databases: UpdateCandidateStateInventorySchema,
  pluginBytes: z.number().nonnegative(),
  pluginPlan: z.literal(UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME),
});
const UpdateStateSchemaInspectionPlanSchema = z.object({
  files: z.array(z.tuple([z.string(), StateDatabaseDiscoverySchema])),
  sharedVersion: UpdateStateSchemaVersionsSchema.element,
});
type UpdateStateSchemaInspectionPlan = z.infer<typeof UpdateStateSchemaInspectionPlanSchema>;

function queueStateDatabaseSpelling(
  files: Map<string, StateDatabaseDiscovery>,
  identity: string,
  file: string,
): void {
  const discovery = files.get(identity);
  if (discovery) {
    if (!discovery.spellings.includes(file)) {
      discovery.spellings.push(file);
    }
    return;
  }
  files.set(identity, { spellings: [file] });
}

function collectRegisteredPaths(
  db: DatabaseSync,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
) {
  const rows = tableExists(db, "agent_databases")
    ? executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<CandidateStateDatabase>(db)
          .selectFrom("agent_databases")
          .select("path")
          .orderBy("path"),
      ).rows
    : [];
  return rows.map(({ path: stored }) => {
    const source = resolveOpenClawRegisteredAgentDatabasePath(shared, stored);
    // Discover registrations from the exact private generation being inspected.
    // Spellings dedupe on one projection identity per database, but every raw
    // alias stays queued: released workers reported them all, and released
    // rollback baselines compare exact paths against the versions response.
    queueStateDatabaseSpelling(
      files,
      resolveUpdateCandidateStateIdentity(resolveOpenClawStateDirForDatabasePath(shared), source),
      source,
    );
    return { stored, source };
  });
}

async function withStateDatabaseSnapshot<T>(
  file: string,
  read: (location: string) => T | Promise<T>,
  stagingRoot?: string,
): Promise<T> {
  // The sync snapshot never attaches SQLite to the live family. Production runs
  // in our dedicated child so filesystem closes cannot release updater locks.
  const snapshot = prepareSqliteReadOnlyLocationSyncInProcess(file, stagingRoot);
  let outcome: { value: T } | { cause: unknown };
  try {
    outcome = { value: await read(snapshot.location) };
  } catch (cause) {
    outcome = { cause };
  }
  if (!snapshot.cleanup()) {
    // The exit retry is best-effort, not proof that this private copy was removed.
    const readFailure =
      "cause" in outcome
        ? `${outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)}; `
        : "";
    throw new Error(
      `${readFailure}State database snapshot cleanup failed: ${path.dirname(snapshot.location)}. Check directory permissions and available storage before retrying.`,
      "cause" in outcome ? outcome : undefined,
    );
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

export async function collectStateDatabasePaths(
  input: StateInput,
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
  const queue = (file: string) => {
    queueStateDatabaseSpelling(files, resolveUpdateCandidateStateIdentity(stateRoot, file), file);
  };
  queue(shared);
  let directories: string[] = [];
  try {
    directories = (await fs.readdir(path.join(input.stateDir, "agents"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
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
      queue(path.join(resolveUserPath(agent.agentDir, input.env), "openclaw-agent.sqlite"));
    }
  }
  for (const id of new Set(["main", ...directories])) {
    queue(path.resolve(input.stateDir, "agents", id, "agent", "openclaw-agent.sqlite"));
  }
  return new Map(
    [...files.entries()].toSorted(([, a], [, b]) =>
      a.spellings[0] < b.spellings[0] ? -1 : a.spellings[0] > b.spellings[0] ? 1 : 0,
    ),
  );
}

/** Released updaters compare exact response paths, so every raw alias is published. */
function publishStateDatabaseVersions(
  files: Map<string, StateDatabaseDiscovery>,
  inspected: Map<string, Omit<UpdateStateSchemaVersion, "path">>,
): UpdateStateSchemaVersion[] {
  const versions: UpdateStateSchemaVersion[] = [];
  for (const [identity, discovery] of files) {
    const result = inspected.get(identity);
    if (!result) {
      continue;
    }
    for (const spelling of discovery.spellings) {
      versions.push({ path: spelling, ...result });
    }
  }
  return versions;
}

/** Read registrations and plugin ownership from one private shared copy before budgeting. */
export async function readUpdateCandidateStateInventoryInProcess(
  input: StateInput & { targetStateDir: string; candidateRoot: string },
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
  const files = await collectStateDatabasePaths(input);
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const measure = async (
    sharedStateDatabasePath?: string,
  ): Promise<z.infer<typeof UpdateCandidateSnapshotInventorySchema>> => {
    const plugins = await prepareUpdateCandidatePlugins({
      ...input,
      sharedStateDatabasePath,
      onProgress,
    });
    await fs.writeFile(planPath, JSON.stringify(plugins));
    return {
      databases: files,
      pluginBytes: plugins.bytes,
      pluginPlan: UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
    };
  };
  if (await fileExists(shared)) {
    return withStateDatabaseSnapshot(shared, async (location) => {
      const db = openNodeSqliteDatabase(location, { readOnly: true });
      try {
        collectRegisteredPaths(db, shared, files);
      } finally {
        db.close();
      }
      return measure(location);
    });
  }
  return measure();
}

function readStateDatabaseVersion(
  location: string,
  file: string,
  shared: string,
  files: Map<string, StateDatabaseDiscovery>,
): Omit<UpdateStateSchemaVersion, "path"> {
  const db = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    if (file === shared) {
      collectRegisteredPaths(db, shared, files);
    }
    return {
      userVersion: readSqliteUserVersion(db),
      ...(file === shared ? { contentVersion: readStateSchemaContentVersion(db) } : {}),
    };
  } finally {
    db.close();
  }
}

/** Discover registered stores from the same private shared-database generation used for inspection. */
export async function discoverUpdateStateSchemaInspectionInProcess(
  input: StateInput & { stagingRoot: string },
): Promise<UpdateStateSchemaInspectionPlan> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = await collectStateDatabasePaths(input);
  if (!(await fileExists(shared))) {
    return { files: [...files], sharedVersion: { path: shared, userVersion: null } };
  }
  const sharedVersion = await withStateDatabaseSnapshot(
    shared,
    (location) => ({
      path: shared,
      ...readStateDatabaseVersion(location, shared, shared, files),
    }),
    input.stagingRoot,
  );
  return { files: [...files], sharedVersion };
}

/** Missing databases stay explicit so creation is schema-checked and loss blocks rollback. */
export async function readUpdateStateSchemaVersionsInProcess(
  input: StateInput & {
    inspectionPlan?: UpdateStateSchemaInspectionPlan;
    stagingRoot?: string;
  },
): Promise<UpdateStateSchemaVersion[]> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = input.inspectionPlan
    ? new Map(input.inspectionPlan.files)
    : await collectStateDatabasePaths(input);
  const sharedIdentity = resolveUpdateCandidateStateIdentity(input.stateDir, shared);
  // Inspect each identity once, then publish every spelling for released rollback baselines.
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  for (const [identity, discovery] of files) {
    const file = discovery.spellings[0];
    if (identity === sharedIdentity && input.inspectionPlan) {
      const { userVersion, contentVersion } = input.inspectionPlan.sharedVersion;
      inspected.set(identity, {
        userVersion,
        ...(contentVersion === undefined ? {} : { contentVersion }),
      });
      continue;
    }
    // Missing stores stay explicit so creation is checked and loss blocks rollback.
    if (!(await fileExists(file))) {
      inspected.set(identity, { userVersion: null });
      continue;
    }
    if (file !== shared) {
      // Reuse the native WAL-aware owner inside this child, avoiding both agent
      // payload copies and a nested worker with a separate cleanup lifetime.
      const { userVersion } = await inspectSqliteSchemaHeaderInProcess(file);
      inspected.set(identity, { userVersion });
      continue;
    }
    inspected.set(
      identity,
      await withStateDatabaseSnapshot(
        file,
        (location) => readStateDatabaseVersion(location, file, shared, files),
        input.stagingRoot,
      ),
    );
  }
  return publishStateDatabaseVersions(files, inspected);
}

async function runUpdateStateInspectionWorker(params: {
  input: StateInput & Record<string, unknown>;
  nodeRunner: string;
  root?: string;
  signal?: AbortSignal;
  sourceEnv: NodeJS.ProcessEnv;
  stagingRoot: string;
  timeoutMs: number;
  readOnlySource?: string;
}) {
  const workerUrl = resolveRuntimeWorkerUrl({
    ...(params.readOnlySource
      ? runtimeProcessEntrypoints.sqliteReadOnly
      : runtimeProcessEntrypoints.updateCandidateState),
    root: params.root,
  });
  const sourceTsconfigPath = /\.[cm]?ts$/.test(fileURLToPath(workerUrl))
    ? fileURLToPath(new URL("../../tsconfig.json", workerUrl))
    : undefined;
  return await runCommandBuffered(
    [
      params.nodeRunner,
      ...resolveRuntimeWorkerArgv(workerUrl, params.nodeRunner),
      ...(params.readOnlySource
        ? [SQLITE_READONLY_CHILD_ARG, "sync", params.readOnlySource, params.stagingRoot]
        : []),
    ],
    {
      cwd: os.tmpdir(),
      input: params.readOnlySource
        ? undefined
        : JSON.stringify({
            ...params.input,
            env: {
              HOME: params.sourceEnv.HOME,
              OPENCLAW_HOME: params.sourceEnv.OPENCLAW_HOME,
              USERPROFILE: params.sourceEnv.USERPROFILE,
              OPENCLAW_AGENT_DIR: params.sourceEnv.OPENCLAW_AGENT_DIR,
              PI_CODING_AGENT_DIR: params.sourceEnv.PI_CODING_AGENT_DIR,
            },
          }),
      baseEnv: params.sourceEnv,
      env: {
        XDG_CACHE_HOME: params.stagingRoot,
        ...(sourceTsconfigPath ? { TSX_TSCONFIG_PATH: sourceTsconfigPath } : {}),
      },
      timeoutMs: params.timeoutMs,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      signal: params.signal,
    },
  );
}

function parseUpdateStateInspectionWorker<T>(
  result: Awaited<ReturnType<typeof runUpdateStateInspectionWorker>>,
  schema: z.ZodType<T>,
): T {
  if (result.code !== 0) {
    const signal = result.signal ? `, signal ${result.signal}` : "";
    throw new Error(
      `State schema inspection failed (${result.termination}${signal}): ${result.stderr.toString("utf8") || result.stdout.toString("utf8")}`,
    );
  }
  return schema.parse(JSON.parse(result.stdout.toString("utf8")));
}

/** Released candidates can snapshot shared state even when they cannot expose discovery. */
async function discoverLegacyUpdateStateSchemaInspection(
  params: Parameters<typeof runUpdateStateInspectionWorker>[0],
): Promise<UpdateStateSchemaInspectionPlan> {
  const shared = path.resolve(params.input.stateDir, "state", "openclaw.sqlite");
  const files = await collectStateDatabasePaths(params.input);
  if (!(await fileExists(shared))) {
    return { files: [...files], sharedVersion: { path: shared, userVersion: null } };
  }
  const stagingRoot = await createSqliteSnapshotStagingDirectory(params.stagingRoot);
  let outcome: { value: UpdateStateSchemaInspectionPlan } | { cause: unknown };
  try {
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
      ...readStateDatabaseVersion(snapshot.location, shared, shared, files),
    };
    outcome = { value: { files: [...files], sharedVersion } };
  } catch (cause) {
    outcome = { cause };
  }
  // Settle the copy worker and close the private reader before removing discovery staging.
  if (!removeTempDirectory(stagingRoot)) {
    throw new Error(`State schema inspection snapshot cleanup failed: ${stagingRoot}`, {
      cause: "cause" in outcome ? outcome.cause : undefined,
    });
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

/** Schema fencing reads private copies in candidate workers under size-aware deadlines. */
export async function readUpdateStateSchemaVersions({
  root,
  nodeRunner = process.execPath,
  signal,
  ...input
}: StateInput & {
  // Omit only before activation; null forbids falling back after an uncertain swap.
  root?: string | null;
  nodeRunner?: string;
  signal?: AbortSignal;
}): Promise<UpdateStateSchemaVersion[]> {
  if (root === null) {
    throw new Error("The active installation root is unknown; state inspection is unsafe.");
  }
  const sourceEnv = input.env ?? process.env;
  const stagingRoot = await createSqliteSnapshotStagingDirectory();
  let outcome: { value: UpdateStateSchemaVersion[] } | { cause: unknown };
  try {
    const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
    const sizeOptions = { nodeRunner, signal, sourceEnv, stagingRoot };
    const [sharedDatabase] = await readUpdateStateDatabaseSizes([shared], sizeOptions);
    const discoveryResult = await runUpdateStateInspectionWorker({
      input: { ...input, mode: "discover", stagingRoot },
      nodeRunner,
      root,
      signal,
      sourceEnv,
      stagingRoot,
      timeoutMs: resolveAggregateSqliteInspectionTimeoutMs(
        "state schema inspection",
        sharedDatabase ? [sharedDatabase] : [],
      ),
    });
    const legacyWorker =
      discoveryResult.code !== 0 &&
      discoveryResult.stderr.toString("utf8").includes("Unknown update state inspection mode");
    // Activation may replace the updater package. Both legacy subprocesses must use the candidate.
    const discovery = legacyWorker
      ? await discoverLegacyUpdateStateSchemaInspection({
          input,
          nodeRunner,
          root,
          signal,
          sourceEnv,
          stagingRoot,
          timeoutMs: resolveAggregateSqliteInspectionTimeoutMs(
            "state schema inspection",
            sharedDatabase ? [sharedDatabase] : [],
          ),
        })
      : parseUpdateStateInspectionWorker(discoveryResult, UpdateStateSchemaInspectionPlanSchema);
    const sharedIdentity = resolveUpdateCandidateStateIdentity(input.stateDir, shared);
    // Legacy workers recopy the shared database and may inspect every raw alias.
    // Current workers reuse the discovered shared version and inspect each remaining identity once.
    const files = legacyWorker
      ? discovery.files.flatMap(([, database]) => database.spellings)
      : discovery.files
          .filter(([identity]) => identity !== sharedIdentity)
          .map(([, database]) => database.spellings[0]);
    outcome = {
      value: parseUpdateStateInspectionWorker(
        await runUpdateStateInspectionWorker({
          input: legacyWorker
            ? { ...input, mode: "versions" }
            : { ...input, mode: "versions", stagingRoot, inspectionPlan: discovery },
          nodeRunner,
          root,
          signal,
          sourceEnv,
          stagingRoot,
          timeoutMs: resolveAggregateSqliteInspectionTimeoutMs(
            "state schema inspection",
            await readUpdateStateDatabaseSizes(files, sizeOptions),
          ),
        }),
        UpdateStateSchemaVersionsSchema,
      ),
    };
  } catch (cause) {
    outcome = { cause };
  }
  if (!removeTempDirectory(stagingRoot)) {
    throw new Error(`State schema inspection snapshot cleanup failed: ${stagingRoot}`, {
      cause: "cause" in outcome ? outcome.cause : undefined,
    });
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

/** Keep snapshot dependencies out of schema inspection; rebind registry paths to private copies. */
export async function snapshotUpdateCandidateState(
  input: StateInput & {
    targetStateDir: string;
    candidateRoot: string;
    pluginPlanPath: string;
    databaseInventory: string[];
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
  const targetPath = (source: string) =>
    path.join(
      resolveUpdateCandidateStatePath(sourceRoot, input.targetStateDir, path.dirname(source)),
      path.basename(source),
    );
  // Physical copies dedupe on projection identity; the published versions
  // keep every raw alias so released rollback baselines still match.
  const files = await collectStateDatabasePaths(input);
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  for (const [identity, discovery] of files) {
    if (!admittedDatabases.has(identity)) {
      throw new Error(
        `State database registration changed after snapshot inventory: ${discovery.spellings[0]}`,
      );
    }
    const file = discovery.spellings[0];
    if (!(await fileExists(file))) {
      inspected.set(identity, { userVersion: null });
      continue;
    }
    const target = targetPath(file);
    let contentVersion: number | undefined;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const snapshot = await withStateDatabaseSnapshot(file, (sourcePath) =>
      createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath: target,
        ...(file === shared
          ? {
              transform: (db: DatabaseSync) => {
                contentVersion = readStateSchemaContentVersion(db);
                const queries = getNodeSqliteKysely<CandidateStateDatabase>(db);
                // Source process leases cannot own the independently opened rehearsal copy.
                for (const table of ["agent_database_leases", "state_leases"] as const) {
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
      }),
    );
    inspected.set(identity, {
      userVersion: snapshot.userVersion,
      ...(contentVersion === undefined ? {} : { contentVersion }),
    });
  }
  const versions = publishStateDatabaseVersions(files, inspected);
  const pluginPaths = await copyUpdateCandidatePlugins(plugins, input);
  return { versions, pluginPaths };
}
