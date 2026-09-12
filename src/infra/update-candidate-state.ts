import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";

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
): Promise<T> {
  // The sync snapshot never attaches SQLite to the live family. Production runs
  // in our dedicated child so filesystem closes cannot release updater locks.
  const snapshot = prepareSqliteReadOnlyLocationSyncInProcess(file);
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

/** Missing databases stay explicit so creation is schema-checked and loss blocks rollback. */
export async function readUpdateStateSchemaVersionsInProcess(
  input: StateInput,
): Promise<UpdateStateSchemaVersion[]> {
  const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
  const files = await collectStateDatabasePaths(input);
  // Inspect each physical database once on its first spelling; every raw alias
  // publishes the same result so released mixed-alias baselines still match.
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  for (const [identity, discovery] of files) {
    const file = discovery.spellings[0];
    inspected.set(
      identity,
      (await fileExists(file))
        ? await withStateDatabaseSnapshot(file, (location) => {
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
          })
        : { userVersion: null },
    );
  }
  return publishStateDatabaseVersions(files, inspected);
}

/** Schema fencing reads private copies in a child under a fixed inspection deadline. */
export async function readUpdateStateSchemaVersions({
  root,
  nodeRunner = process.execPath,
  ...input
}: StateInput & {
  // Omit only before activation; null forbids falling back after an uncertain swap.
  root?: string | null;
  nodeRunner?: string;
}): Promise<UpdateStateSchemaVersion[]> {
  if (root === null) {
    throw new Error("The active installation root is unknown; state inspection is unsafe.");
  }
  const sourceEnv = input.env ?? process.env;
  const result = await runCommandBuffered(
    [
      nodeRunner,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.updateCandidateState, root }),
        nodeRunner,
      ),
    ],
    {
      cwd: os.tmpdir(),
      input: JSON.stringify({
        ...input,
        mode: "versions",
        env: {
          HOME: sourceEnv.HOME,
          OPENCLAW_HOME: sourceEnv.OPENCLAW_HOME,
          USERPROFILE: sourceEnv.USERPROFILE,
          OPENCLAW_AGENT_DIR: sourceEnv.OPENCLAW_AGENT_DIR,
          PI_CODING_AGENT_DIR: sourceEnv.PI_CODING_AGENT_DIR,
        },
      }),
      baseEnv: sourceEnv,
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `State schema inspection failed (${result.termination}): ${result.stderr.toString("utf8")}`,
    );
  }
  return UpdateStateSchemaVersionsSchema.parse(JSON.parse(result.stdout.toString("utf8")));
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
