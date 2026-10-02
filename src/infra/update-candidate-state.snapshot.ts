import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";
import { readDatabasePathIdentity } from "./sqlite-worker-identity.js";
import {
  resolveUpdateCandidateStateIdentity,
  resolveUpdateCandidateStatePath,
  type StateDatabaseDiscovery,
} from "./update-candidate-paths.js";
import {
  sealUpdateCandidatePluginCodeLinks,
  type UpdateCandidatePluginCodeLink,
} from "./update-candidate-plugin-code-links.js";
import {
  createUpdateStateSnapshotReporter,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  collectStateDatabasePaths,
  collectRegisteredPaths,
  updateStatePathExists,
  publishStateDatabaseVersions,
  type CandidateStateDatabase,
  type StateInput,
  type UpdateStateSchemaVersion,
  type UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

/** Keep snapshot dependencies out of schema inspection; rebind registry paths to private copies. */
export async function snapshotUpdateCandidateState(
  input: StateInput & {
    targetStateDir: string;
    candidateRoot: string;
    pluginPlanPath: string;
    databaseInventory: string[];
    sessionProjection?: boolean;
    onProgress?: (progress: UpdateStateInspectionProgress) => void;
  },
): Promise<z.infer<typeof UpdateCandidateStateSnapshotSchema>> {
  await fs.mkdir(input.targetStateDir, { recursive: true, mode: 0o700 });
  const { createVerifiedSqliteSnapshot } = await import("./sqlite-snapshot.js");
  const { copyUpdateCandidatePlugins, UpdateCandidatePluginPlanSchema } =
    await import("./update-candidate-plugins.js");
  const plugins = UpdateCandidatePluginPlanSchema.parse(
    JSON.parse(await fs.readFile(input.pluginPlanPath, "utf8")),
  );
  const { prepareUpdateCandidateSessions } = await import("./update-candidate-sessions.js");
  type Sessions = Awaited<ReturnType<typeof prepareUpdateCandidateSessions>>;
  let sessions: Sessions | undefined;
  let sessionProjection: ReturnType<Sessions["project"]> | undefined;
  const prepareSessions = async (database?: DatabaseSync) => {
    sessions = await prepareUpdateCandidateSessions(input, database);
    if (sessions.bytes > 0 && input.config.session?.store && !input.sessionProjection) {
      throw new Error(
        "This update driver cannot project the configured legacy session store. Preserve the original state, then run openclaw doctor --fix --non-interactive --yes with the same state and configuration before retrying the update.",
      );
    }
    sessionProjection = sessions.project(input.targetStateDir, input.sessionProjection === true);
    // Older drivers omit legacy payload budgeting. The shared image already occupies
    // space; credit only its actual bytes before admitting the remaining copy work.
    if (sessions.bytes > 0) {
      const { measureUpdateStateFiles } = await import("./update-candidate-io.js");
      const { requiredUpdateSnapshotBytes } = await import("./update-snapshot-capacity.js");
      const { tryReadDiskSpace, formatDiskSpaceBytes } = await import("./disk-space.js");
      const required = requiredUpdateSnapshotBytes({
        ...(await measureUpdateStateFiles(input.databaseInventory)),
        pluginBytes: plugins.bytes,
        legacySessionBytes: sessions.bytes,
      });
      const privateLocation = database?.location();
      const stagedBytes = privateLocation ? (await fs.stat(privateLocation)).size : 0;
      const available = tryReadDiskSpace(input.targetStateDir)?.availableBytes;
      if (available === undefined || available + stagedBytes < required) {
        throw new Error(
          `Legacy session snapshot needs ${formatDiskSpaceBytes(required)} of verified free space. Free space or select a larger TMPDIR, then retry the update.`,
        );
      }
    }
  };
  const admittedDatabases = new Set(input.databaseInventory);
  const sourceRoot = path.resolve(input.stateDir);
  const shared = path.join(sourceRoot, "state", "openclaw.sqlite");
  const { createUpdateCandidateExecApprovalsProjection } =
    await import("./update-candidate-exec-approvals.js");
  const requireSessionCapture = () => {
    if (!sessions || !sessionProjection) {
      throw new Error("Shared snapshot did not complete session discovery");
    }
    return { sessions, projection: sessionProjection };
  };
  const targetPath = (source: string) =>
    (source === shared
      ? undefined
      : requireSessionCapture().projection.databasePaths.get(source)) ??
    path.join(
      resolveUpdateCandidateStatePath(sourceRoot, input.targetStateDir, path.dirname(source)),
      path.basename(source),
    );
  const execApprovals = createUpdateCandidateExecApprovalsProjection(sourceRoot, targetPath);
  // Physical copies dedupe on projection identity; the published versions
  // keep every raw alias so released rollback baselines still match.
  const files = await collectStateDatabasePaths(input);
  const inspected = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  const sourceDatabaseIdentities = new Map<string, string>();
  const captureDatabase = async (identity: string, discovery: StateDatabaseDiscovery) => {
    if (!admittedDatabases.has(identity)) {
      throw new Error(
        `State database registration changed after snapshot inventory: ${discovery.spellings[0]}`,
      );
    }
    const file = discovery.spellings[0];
    if (!(await updateStatePathExists(file))) {
      if (file === shared) {
        await prepareSessions();
      }
      inspected.set(identity, { userVersion: null });
      return;
    }
    const target = targetPath(file);
    const captured = file === shared ? undefined : requireSessionCapture().sessions;
    const retained = captured?.targets.some(
      (entry) =>
        resolveUpdateCandidateStateIdentity(sourceRoot, entry.sqlitePath) === identity &&
        captured.receipts.has(entry.sourceTarget),
    );
    const sourceIdentity = retained ? await readDatabasePathIdentity(file) : undefined;
    if (sourceIdentity) {
      sourceDatabaseIdentities.set(identity, sourceIdentity.key.slice("file:".length));
    }
    let contentVersion: number | undefined;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const progress = createUpdateStateSnapshotReporter(file, "database snapshot", input.onProgress);
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath: file,
      targetPath: target,
      sourceAcquisition: {
        mode: "isolated-process",
        stagingRoot: input.targetStateDir,
        ...(sourceIdentity
          ? { preserveSourceArtifacts: true, expectedSourceIdentity: sourceIdentity }
          : {}),
      },
      // The rehearsal is private and disposable; compaction would create another
      // full image and alter implicit row IDs before candidate migrations run.
      preserveRowIds: true,
      onProgress: progress.onProgress,
      ...(file === shared
        ? {
            transform: async (db: DatabaseSync) => {
              const registered = collectRegisteredPaths(db, shared, files);
              await prepareSessions(db);
              contentVersion = readStateSchemaContentVersion(db);
              const queries = getNodeSqliteKysely<CandidateStateDatabase>(db);
              execApprovals.rebaseReceipt(db);
              // Source process leases cannot own the independently opened rehearsal copy.
              for (const table of ["agent_database_leases", "state_leases"] as const) {
                if (tableExists(db, table)) {
                  executeSqliteQuerySync(db, queries.deleteFrom(table));
                }
              }
              for (const { stored, source } of registered) {
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
  };
  const sharedIdentity = resolveUpdateCandidateStateIdentity(sourceRoot, shared);
  const sharedDiscovery = files.get(sharedIdentity);
  if (!sharedDiscovery) {
    throw new Error("Shared database is missing from snapshot discovery");
  }
  // Discovery is path-sorted, not dependency-ordered. Shared capture must establish
  // selectors and receipts before any agent copy, including registry-added targets.
  await captureDatabase(sharedIdentity, sharedDiscovery);
  const captured = requireSessionCapture();
  for (const [identity, discovery] of files) {
    if (identity !== sharedIdentity) {
      await captureDatabase(identity, discovery);
    }
  }
  input.onProgress?.({ phase: "execution approvals snapshot", path: sourceRoot });
  await execApprovals.copySources();
  const copiedShared = targetPath(shared);
  const sharedDatabase = (await updateStatePathExists(copiedShared))
    ? openNodeSqliteDatabase(copiedShared)
    : undefined;
  try {
    const { readDeferredPluginSessionImportReceipt } =
      await import("./deferred-plugin-session-verification.js");
    const preservedIndexes = new Set<string>();
    for (const target of captured.sessions.targets) {
      const original = captured.sessions.receipts.get(target.sourceTarget)?.receipt;
      const copied = sharedDatabase
        ? readDeferredPluginSessionImportReceipt({
            target,
            sqlitePath: target.sqlitePath,
            database: sharedDatabase,
            env: input.env ?? process.env,
          })
        : undefined;
      if (!isDeepStrictEqual(original ?? null, copied ?? null)) {
        throw new Error(`Retained session import changed during snapshot: ${target.storePath}`);
      }
      if (copied) {
        preservedIndexes.add(target.storePath);
      }
    }
    input.onProgress?.({ phase: "legacy session snapshot", path: sourceRoot });
    const paths = await captured.sessions.copy(
      input.targetStateDir,
      captured.projection.path,
      preservedIndexes,
    );
    if (sharedDatabase) {
      const { prepareUpdateCandidateSessionReceipt } =
        await import("./update-candidate-session-receipts.js");
      const publications = new Map<string, () => void>();
      for (const source of captured.sessions.targets) {
        const capturedReceipt = captured.sessions.receipts.get(source.sourceTarget);
        if (!capturedReceipt) {
          continue;
        }
        publications.set(
          capturedReceipt.receipt.sourceKey,
          prepareUpdateCandidateSessionReceipt({
            database: sharedDatabase,
            source,
            captured: capturedReceipt,
            target: {
              agentId: source.agentId,
              storePath: captured.projection.path(source.storePath),
              sqlitePath: targetPath(source.sqlitePath),
            },
            sourceDatabaseIdentity: sourceDatabaseIdentities.get(
              resolveUpdateCandidateStateIdentity(sourceRoot, source.sqlitePath),
            ),
            paths,
            sourceEnv: { ...input.env, OPENCLAW_STATE_DIR: sourceRoot },
            env: { ...input.env, OPENCLAW_STATE_DIR: input.targetStateDir },
          }),
        );
      }
      // Legacy-root and configured discovery can name the same persisted receipt.
      // All raw owners were validated above; relocate their shared authority once.
      for (const publish of publications.values()) {
        publish();
      }
    }
  } finally {
    sharedDatabase?.close();
  }
  const versions = publishStateDatabaseVersions(files, inspected);
  const pluginCodeLinks: UpdateCandidatePluginCodeLink[] = [];
  input.onProgress?.({ phase: "plugin snapshot", path: sourceRoot });
  const pluginPaths = await copyUpdateCandidatePlugins(plugins, {
    ...input,
    onCodeLink: (fact) => {
      pluginCodeLinks.push(fact);
    },
  });
  return {
    versions,
    pluginPaths,
    sessionStore: captured.projection.sessionStore,
    sessionStatePaths: captured.projection.statePaths,
    pluginCodeLinks: await sealUpdateCandidatePluginCodeLinks(
      input.pluginPlanPath,
      pluginCodeLinks,
    ),
  };
}
