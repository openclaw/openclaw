import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import { readDeferredPluginSessionImport } from "../../infra/deferred-plugin-session-sources.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import {
  createAgentDatabaseDeletionClassifier,
  createRetainedAgentDatabaseMatcher,
} from "../../state/agent-deletion-discovery.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { readAgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.read.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../../state/openclaw-database-preflight-agent-scheduler.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  isLegacySessionRecordOwnedByTarget,
  listLegacySessionTranscriptFiles,
  readLegacySessionStoreEntries,
  shouldFilterLegacySessionRecordsByTarget,
} from "./legacy-store-inspection.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isCanonicalSqliteSessionMainKeyCurrent } from "./session-canonical-key-read.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
} from "./targets.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { agentId?: string; storePath: string }[];
  registeredDatabases?: SessionStoreRegistryRead;
  operation?: "doctor";
}): void {
  const env = params.env ?? process.env;
  const readOptions = { env, registeredDatabases: params.registeredDatabases };
  const targets = (
    params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, readOptions)
  ).filter(
    (target) => !target.agentId || !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
  );
  const legacyRootStore = path.join(resolveStateDir(env), "sessions", "sessions.json");
  const legacyTargets = fs.existsSync(legacyRootStore)
    ? resolveSessionStoreTargets(params.cfg, { allAgents: true }, readOptions).map((target) => ({
        agentId: target.agentId,
        sqlitePath: resolveSqliteTargetFromSessionStorePath(target.storePath, {
          agentId: target.agentId,
          ...readOptions,
        }).path,
        storePath: legacyRootStore,
      }))
    : [];
  const sources: readonly { agentId?: string; storePath: string; sqlitePath?: string }[] = [
    ...(legacyTargets.length > 0 ? legacyTargets : [{ storePath: legacyRootStore }]),
    ...targets,
  ];
  const sourcesByPath = new Map<string, Array<(typeof sources)[number]>>();
  for (const target of sources) {
    const sourcePath = path.resolve(target.storePath);
    sourcesByPath.set(sourcePath, [...(sourcesByPath.get(sourcePath) ?? []), target]);
  }
  const legacySources = [...sourcesByPath].filter(
    ([storePath]) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath),
  );
  if (legacySources.length === 0) {
    return;
  }
  const deletionSnapshot = readAgentDatabaseDeletionSnapshot(
    env,
    params.operation === "doctor" ? "maintenance" : "runtime",
  );
  const classifyDeletion =
    deletionSnapshot &&
    createAgentDatabaseDeletionClassifier({
      env,
      retainedDeletions: deletionSnapshot.retainedDeletions,
      registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
      configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(
        params.cfg,
        readOptions,
      ),
    });
  const legacyStore = legacySources.find(([storePath, candidates]) => {
    type SourceOwner = {
      target: { agentId: string; storePath: string; sqlitePath?: string };
      destination: string;
      retained: boolean;
      imported: boolean;
    };
    const owners = new Map<string, SourceOwner>();
    for (const target of candidates) {
      if (!target.agentId) {
        return true;
      }
      const destination =
        target.sqlitePath ??
        resolveSqliteTargetFromSessionStorePath(target.storePath, {
          agentId: target.agentId,
          ...readOptions,
        }).path;
      const deletion =
        classifyDeletion?.(storePath, target.agentId) ??
        classifyDeletion?.(destination, target.agentId);
      const retained = deletion !== undefined && deletion !== "unavailable";
      owners.set(`${target.agentId}\0${destination}`, {
        target: { ...target, agentId: target.agentId },
        destination,
        retained,
        imported:
          !retained &&
          readDeferredPluginSessionImport({
            cfg: params.cfg,
            target: { ...target, agentId: target.agentId },
            sqlitePath: destination,
            env,
            purpose: "readiness",
          }) !== undefined,
      });
    }
    // A shared path still needs record-level ownership even when every candidate is held.
    if (
      [...owners.values()].every(
        ({ target, retained, imported }) =>
          (imported || retained) && !shouldFilterLegacySessionRecordsByTarget(target),
      )
    ) {
      return false;
    }
    // A roster entry is only a possible importer. Inspect retained source ownership
    // here, never in runtime session access, and bind parsed bytes to every receipt.
    const issues: Array<{ code: string; message: string; sessionKey?: string }> = [];
    const source = readLegacySessionStoreEntries({ storePath }, issues);
    if (issues.some((issue) => issue.code !== "entry_invalid") || !source.bytes) {
      return [...owners.values()].some(({ imported, retained }) => !imported && !retained);
    }
    // Empty indexes may have unindexed history: retain the existing requirement
    // for every named owner's verified receipt rather than infer ownership here.
    const required = new Set<SourceOwner>(source.entries.length === 0 ? owners.values() : []);
    for (const sessionKey of [
      ...source.entries.map((entry) => entry.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ]) {
      const matches = [...owners.values()].filter(
        ({ target }) =>
          !shouldFilterLegacySessionRecordsByTarget(target) ||
          isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
      );
      if (matches.length !== 1) {
        return true;
      }
      required.add(matches[0]!);
    }
    let hasUnindexedHistory: boolean | undefined;
    return [...required].some(({ target, destination, retained, imported }) => {
      if (
        imported ||
        (retained &&
          (source.entries.length > 0 || !shouldFilterLegacySessionRecordsByTarget(target)))
      ) {
        return false;
      }
      // Owners without a database cannot have completed a core session import.
      // Without a receipt or unindexed history, demanding one deadlocks startup:
      // Doctor refuses to create a database just for the receipt.
      if (source.entries.length === 0 && !fs.existsSync(destination)) {
        hasUnindexedHistory ??=
          listLegacySessionTranscriptFiles(path.dirname(storePath)).length > 0;
        if (!hasUnindexedHistory) {
          return false;
        }
      }
      return true;
    });
  })?.[0];
  if (legacyStore) {
    throw new SessionStoreMigrationRequiredError(
      params.operation === "doctor"
        ? formatDoctorStateRepairFailure(
            `Legacy session store requires migration at ${legacyStore}`,
            "Repair the retained source using the migration report's named file and validation error, preserving the original history.",
          )
        : `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
  deps?: {
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<void> {
  params.assertCurrent?.();
  const env = params.env ?? process.env;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  const admittedTargets = () =>
    resolveTargets(params.cfg, { env }).filter(
      (target) =>
        (!params.agentIds || params.agentIds.has(target.agentId)) &&
        !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
    );
  const targets = admittedTargets();
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  assertSessionStoreMigrationComplete({ cfg: params.cfg, env, targets });
  const migrateLegacyMain =
    params.deps?.migrateLegacyMainSessionKeys ?? migrateLegacyMainSessionKeys;
  const result = await migrateLegacyMain({ cfg: params.cfg, env, mode: "detect" });
  params.assertCurrent?.();
  if (result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }

  const databases = new Set<string>();
  const registeredDatabases = new Set(
    listOpenClawRegisteredAgentDatabases({ env }).map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  const tasks = targets.map((target) => async () => {
    params.assertCurrent?.();
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      return;
    }
    databases.add(databasePath);
    // Retained stores remain discoverable, but only deletion cleanup may write them.
    // Check the physical owner so surviving shared stores still reach their runtime.
    const skipDeletedDatabase = () => {
      // Each admission follows awaited work; never reuse an earlier journal snapshot.
      const retained = createRetainedAgentDatabaseMatcher(
        env,
        () => resolveConfiguredAgentDatabaseTargets(params.cfg, { env }),
        "database",
        "runtime",
      )(databasePath, options.agentId);
      if (typeof retained !== "object") {
        return false;
      }
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} at ${databasePath} (cleanup complete); run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance`,
      );
      return true;
    };
    if (skipDeletedDatabase()) {
      return;
    }
    const deletion = readAgentDeletionJournal(options.agentId, { env }, "runtime");
    if (deletion) {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} (${deletion.cleanupCompleted ? "cleanup complete" : "cleanup pending; retry agent deletion"})`,
      );
      return;
    }
    const alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
    let handedOff = false;
    try {
      try {
        const mainKey = params.cfg.session?.mainKey;
        if (
          !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
          !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
        ) {
          await withOpenClawAgentDatabaseAsync(
            options,
            (database) => setCanonicalSqliteSessionMainKey(database, mainKey),
            params.assertCurrent,
          );
        }
      } catch (error) {
        params.assertCurrent?.();
        params.log.warn(
          `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
        );
      }
      // Canonical refusal is readiness failure. Drain before runtime visitors can
      // otherwise parse a whole migrated store on the main thread.
      const { certifySessionCanonicalValidationPending } =
        await import("./session-canonical-validation-readiness.js");
      const { withSqliteCanonicalValidationWorker } =
        await import("./session-accessor.sqlite-reclamation-worker.js");
      params.assertCurrent?.();
      if (skipDeletedDatabase()) {
        return;
      }
      await withSqliteCanonicalValidationWorker((withWorker) =>
        certifySessionCanonicalValidationPending(options, withWorker, params.assertCurrent),
      );
      params.assertCurrent?.();
      if (params.handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        params.assertCurrent?.();
        if (skipDeletedDatabase()) {
          return;
        }
        await params.handoffDatabase(options);
        params.assertCurrent?.();
        handedOff = true;
      }
    } finally {
      if (!alreadyOpen && !handedOff) {
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      }
    }
  });
  // Share preflight's two-agent disk budget: overlap admission without multiplying
  // SQLite scans and worker heaps across the whole fleet. Drain active work on failure.
  const { withSqliteCanonicalValidationWorkerPool } =
    await import("./session-accessor.sqlite-canonical-worker-pool.js");
  await withSqliteCanonicalValidationWorkerPool(env, async () => {
    const { hasError, firstError } = await runTasksWithConcurrency({
      tasks,
      limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
      errorMode: "stop",
    });
    if (hasError) {
      throw firstError;
    }
  });
  params.assertCurrent?.();
}
