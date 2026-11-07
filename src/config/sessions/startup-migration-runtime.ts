import fs from "node:fs";
import { formatCliCommand } from "../../cli/command-format.js";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { settleCurrentReadPreparations } from "../../shared/current-read-authority.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot } from "../../state/agent-deletion-discovery.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import {
  AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../../state/openclaw-agent-db-contract.js";
import { agentEngineInput } from "../../state/openclaw-agent-db-engine.js";
import { listOpenClawRegisteredAgentDatabasesAsync } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isCanonicalSqliteSessionMainKeyCurrent } from "./session-canonical-key-read.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { assertSessionStoreMigrationComplete } from "./startup-migration.js";
import {
  isConfiguredAgentDatabaseTarget,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "./targets.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
}): Promise<void> {
  params.assertCurrent?.();
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const registeredDatabaseRows = await listOpenClawRegisteredAgentDatabasesAsync({ env });
  params.assertCurrent?.();
  const deletionRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
  let deletionSnapshot: ReturnType<typeof deletionRead.read> | undefined;
  const admittedTargets = () =>
    resolveAllAgentSessionStoreTargetsSync(params.cfg, {
      env,
      agentIds: params.agentIds,
      registeredDatabases: registeredDatabaseRows,
    }).filter(
      (target) =>
        (!params.agentIds || params.agentIds.has(target.agentId)) &&
        !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
    );
  const targets = admittedTargets();
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  withEngineStoreAdmission(() =>
    assertSessionStoreMigrationComplete({
      cfg: params.cfg,
      env,
      targets,
      registeredDatabases: registeredDatabaseRows,
    }),
  );
  const { assertAcpSessionKeysMigratedForStartup, assertEmbeddedAcpMetadataMigratedForStartup } =
    await import("../../acp/runtime/session-meta-startup.js");
  const { migrateLegacyMainSessionKeys } = await import("./legacy-main-session-migration.js");
  // Both inspections are read-only; join them before repair, including on refusal.
  const [, result] = await settleCurrentReadPreparations([
    params.agentIds
      ? undefined
      : assertAcpSessionKeysMigratedForStartup(
          params.cfg,
          env,
          targets.map((target) => target.agentId),
          undefined,
          params.assertCurrent,
        ),
    // Fleet-wide guidance belongs to boot; a deferred agent must not wait on other stores.
    params.agentIds
      ? undefined
      : migrateLegacyMainSessionKeys({ cfg: params.cfg, env, mode: "detect" }),
  ] as const);
  params.assertCurrent?.();
  if (result && result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }

  const databases = new Set<string>();
  const coldCloses = new Set<string>();
  let interruptedSessions = 0;
  const terminalUnmatched = new Map<string, number>();
  const registeredDatabases = new Set(
    registeredDatabaseRows.map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  const configuredTargets = resolveConfiguredAgentDatabaseCandidatePaths(params.cfg, {
    env,
  }).map((pathname) => ({ path: pathname }));
  const tasks = targets.map((target) => async () => {
    params.assertCurrent?.();
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      return;
    }
    databases.add(databasePath);
    // Discovery is fixed for this startup pass; database owners fence later deletion effects.
    const { snapshot } = await (deletionSnapshot ??= deletionRead.read());
    params.assertCurrent?.();
    const deletion = snapshot?.deletedAgents.find((entry) => entry.agentId === options.agentId);
    if (deletion) {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} (${deletion.status === "complete" ? "cleanup complete" : "cleanup pending; retry agent deletion"})`,
      );
      return;
    }
    // Retained stores remain discoverable, but only deletion cleanup may write them.
    // Check the physical owner so surviving shared stores still reach their runtime.
    const retained = createRetainedAgentDatabaseMatcherFromSnapshot(
      env,
      () =>
        resolveConfiguredAgentDatabaseTargets(params.cfg, {
          env,
          registeredDatabases: (snapshot?.registeredAgentDatabases ?? []).filter(
            (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
          ),
        }),
      snapshot,
      "database",
      "runtime",
    )(databasePath, options.agentId);
    if (typeof retained === "object") {
      params.log.info(
        `session: skipping deleted agent database for ${options.agentId} at ${databasePath} (cleanup complete); run "${formatCliCommand("openclaw doctor --fix", env)}" for explicit restoration guidance`,
      );
      return;
    }
    // Missing registry entries still need recovery before runtime can discover their lineage.
    if (
      registeredDatabases.has(`${options.agentId}\0${databasePath}`) &&
      !isConfiguredAgentDatabaseTarget(configuredTargets, options.agentId, databasePath)
    ) {
      return;
    }
    let alreadyOpen: boolean | undefined;
    let handedOff = false;
    try {
      const { repairLegacySessionRunOutcomes } =
        await import("../../commands/doctor/shared/session-entry-rewrite.js");
      params.assertCurrent?.();
      alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
      const mainKey = params.cfg.session?.mainKey;
      try {
        if (
          !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
          !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
        ) {
          if (agentEngineInput()) {
            withEngineStoreAdmission(() => {
              params.assertCurrent?.();
              setCanonicalSqliteSessionMainKey(openOpenClawAgentDatabase(options), mainKey);
            });
          } else {
            await withOpenClawAgentDatabaseAsync(
              options,
              (database) => setCanonicalSqliteSessionMainKey(database, mainKey),
              params.assertCurrent,
            );
          }
        }
      } catch (error) {
        params.assertCurrent?.();
        params.log.warn(
          `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
        );
      }
      let embeddedAcpSessionKey: string | undefined;
      const repaired = await repairLegacySessionRunOutcomes(
        { agentId: options.agentId, env, storePath: databasePath },
        () => params.assertCurrent?.(),
        (row) => {
          // Pre-repair rows are valid only while legacy repair never adds or removes `acp`.
          if (
            embeddedAcpSessionKey === undefined &&
            parseSqliteSessionEntryRecord(row)?.acp != null
          ) {
            embeddedAcpSessionKey = row.session_key;
          }
        },
        params.log.warn,
      );
      interruptedSessions += repaired.repaired;
      if (repaired.terminalUnmatched > 0) {
        terminalUnmatched.set(
          options.agentId,
          (terminalUnmatched.get(options.agentId) ?? 0) + repaired.terminalUnmatched,
        );
      }
      // Canonical refusal is readiness failure. Drain before runtime visitors can
      // otherwise parse a whole migrated store on the main thread.
      const { certifySessionCanonicalValidationPending } =
        await import("./session-canonical-validation-readiness.js");
      const { withSqliteCanonicalValidationWorker } =
        await import("./session-accessor.sqlite-reclamation-worker.js");
      params.assertCurrent?.();
      await withSqliteCanonicalValidationWorker((withWorker) =>
        certifySessionCanonicalValidationPending(options, withWorker, params.assertCurrent),
      );
      params.assertCurrent?.();
      if (params.agentIds) {
        await assertAcpSessionKeysMigratedForStartup(
          params.cfg,
          env,
          targets.map((admittedTarget) => admittedTarget.agentId),
          options,
          params.assertCurrent,
        );
      }
      assertEmbeddedAcpMetadataMigratedForStartup(options, embeddedAcpSessionKey);
      const handoffDatabase = params.handoffDatabase;
      if (handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        params.assertCurrent?.();
        await handoffDatabase(options);
        params.assertCurrent?.();
        handedOff = true;
      }
    } finally {
      if (alreadyOpen === false && !handedOff) {
        coldCloses.add(databasePath);
      }
    }
  });
  // Share preflight's two-agent disk budget: overlap admission without multiplying
  // SQLite scans and worker heaps across the whole fleet. Drain active work on failure.
  const { withSqliteCanonicalValidationWorkerPool } =
    await import("./session-accessor.sqlite-canonical-worker-pool.js");
  const errors = new Set<unknown>();
  try {
    await withSqliteCanonicalValidationWorkerPool(env, async () => {
      const { hasError, firstError } = await runTasksWithConcurrency({
        tasks,
        limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
        errorMode: "stop",
      });
      if (hasError) {
        errors.add(firstError);
        throw firstError;
      }
    });
  } catch (error) {
    errors.add(error);
  }
  // Native lease release writes shared state synchronously; sibling workers must
  // finish their admission requests before cold handles close on the main thread.
  for (const databasePath of coldCloses) {
    try {
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    } catch (error) {
      errors.add(error);
    }
  }
  for (const [agentId, count] of terminalUnmatched) {
    params.log.warn(
      `session: agent ${agentId} has ${count} terminal unmatched legacy restart custody row(s); openclaw doctor --fix retires them.`,
    );
  }
  throwSqliteLifecycleErrors([...errors], "Session startup migration and cleanup failed");
  if (interruptedSessions > 0) {
    params.log.info(`session: settled ${interruptedSessions} legacy run(s)`);
  }
  params.assertCurrent?.();
}
