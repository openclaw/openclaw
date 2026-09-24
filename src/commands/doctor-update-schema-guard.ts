import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { resolveStateDir } from "../config/paths.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import type { UpdateDoctorWriteAuthority } from "../infra/update-doctor-result.js";
import { POST_CORE_UPDATE_ENV } from "../infra/update-post-core-context.js";
import {
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "../infra/update-run-driver.js";
import { UpdateRunRecordSchema } from "../infra/update-run-schema.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readStateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { VERSION } from "../version.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import {
  prepareDoctorDatabasePreflight,
  type DoctorDatabasePreflight,
} from "./doctor-database-preflight.js";
import {
  recordUpdateDoctorRefusal,
  resolveUpdateDoctorGitRecovery,
} from "./doctor-update-refusal.js";
import { isUpdatePackageSwapInProgress } from "./doctor/shared/update-phase.js";

type DrivingUpdater = {
  runId: string;
  version: string;
  canDeferStateSchema: boolean;
  earlyDoctorRunning: boolean;
  postCoreStarted: boolean;
};

// Unknown file IDs cannot prove that a recovery image covers the pending live mutation.
function sameSnapshotFile(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">) {
  return left.dev !== 0 && left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

async function readDrivingUpdater(): Promise<DrivingUpdater | undefined> {
  // The runtime ledger reader consults quarantine state. This diagnostic must
  // not open any live database, including a quarantine store needing recovery.
  const snapshot = await prepareSqliteReadOnlyLocation(resolveOpenClawStateSqlitePath(), {
    preserveSourceArtifacts: true,
  });
  try {
    const database = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    let closeSchemaReadAdmission: (() => void) | undefined;
    try {
      closeSchemaReadAdmission = openDoctorStateSchemaReadAdmission(database);
      const blocker = readStateSchemaPublicationBlocker(database);
      if (!blocker) {
        return undefined;
      }
      const row = executeSqliteQueryTakeFirstSync(
        database,
        getNodeSqliteKysely<Pick<DB, "update_runs">>(database)
          .selectFrom("update_runs")
          .select(["status", "steps_json"])
          .where("run_id", "=", blocker.runId),
      );
      const steps = UpdateRunRecordSchema.shape.steps.safeParse(
        row ? safeParseJson(row.steps_json) : [],
      );
      const stepStatus = (name: string) =>
        steps.success ? steps.data.findLast((step) => step.step === name)?.status : undefined;
      return {
        runId: blocker.runId,
        version: blocker.updaterVersion,
        canDeferStateSchema: tableExists(database, "config_machine_state"),
        earlyDoctorRunning:
          row?.status === "running" && stepStatus("openclaw doctor") === "in_progress",
        postCoreStarted:
          row?.status === "running" &&
          stepStatus("openclaw doctor") === "completed" &&
          stepStatus("post-update verification") === "in_progress",
      };
    } finally {
      try {
        closeSchemaReadAdmission?.();
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      }
    }
  } finally {
    await snapshot.cleanupAsync();
  }
}

/** Prepare reusable fleet facts and refuse before CLI bootstrap or Doctor can write state. */
export async function guardUpdateDoctorSchemaUpgrade(options: {
  schemas?: DoctorDatabasePreflight;
  runtime?: RuntimeEnv;
  json?: boolean;
  postCoreSchemaRepair?: UpdateDoctorWriteAuthority["postCoreSchemaRepair"];
}): Promise<DoctorDatabasePreflight | undefined> {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1") {
    return undefined;
  }
  const schemas = options.schemas ?? (await prepareDoctorDatabasePreflight());
  if (!schemas.pendingMigrations?.length) {
    return schemas;
  }
  let updater: Awaited<ReturnType<typeof readDrivingUpdater>>;
  try {
    updater = await readDrivingUpdater();
  } catch {
    // A missing or unreadable run cannot prove that the driver writes the ledger.
  }
  if (!updater) {
    return schemas;
  }
  const blockedMigrations = schemas.pendingMigrations.filter(
    (database) => database.kind === "agent" || !updater.canDeferStateSchema,
  );
  if (blockedMigrations.length === 0) {
    return schemas;
  }
  const postCoreRecovery = {
    message:
      "The update has already committed its package. Complete Doctor repair with the installed compatible build before restarting the Gateway; package rollback cannot undo migrated state.",
    commands: ["openclaw doctor --fix", "openclaw gateway start"],
  };
  const recovery = updater.postCoreStarted
    ? postCoreRecovery
    : await resolveUpdateDoctorGitRecovery();
  if (updater.canDeferStateSchema && blockedMigrations.every((entry) => entry.kind === "agent")) {
    const capturePending = () =>
      blockedMigrations.map((database) => ({
        database,
        identity: statSync(database.path),
      }));
    const coverageRefusal = (uncovered: typeof blockedMigrations, detail: string) =>
      new UpdateSchemaRefusalError(uncovered, updater.version, {
        targetVersion: VERSION,
        cause: new Error(`Missing recoverable canonical backup coverage: ${detail}`),
        recovery,
      });
    const authority = options.postCoreSchemaRepair;
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    // Phase flags are only facts: the fresh child must still own its current
    // executor and schema-maintenance scope throughout backup and live repair.
    if (
      authority?.runId === updater.runId &&
      updater.postCoreStarted &&
      maintenance?.ownsSchemaMaintenance
    ) {
      const pending = capturePending();
      const assertCurrent = () => {
        authority.assertCurrent();
        maintenance.assertAdmission();
        const changed = pending.filter(({ database, identity }) => {
          const current = statSync(database.path, { throwIfNoEntry: false });
          return !current?.isFile() || !sameSnapshotFile(identity, current);
        });
        if (changed.length) {
          throw coverageRefusal(
            changed.map(({ database }) => database),
            "a pending agent database changed physical identity.",
          );
        }
      };
      assertCurrent();
      const [{ createBackupArchive }, { verifyBackupArchive }, { resolveUpdateCaptureRoot }] =
        await Promise.all([
          import("../infra/backup-create.js"),
          import("./backup-verify.js"),
          import("../infra/update-capture-paths.js"),
        ]);
      assertCurrent();
      let snapshotFacts: readonly BackupSqliteSnapshotFact[] = [];
      const backup = await createBackupArchive({
        output: path.join(
          resolveUpdateCaptureRoot(resolveStateDir()),
          `agent-schema-${updater.runId}-${randomUUID()}.tar.gz`,
        ),
        includeWorkspace: false,
        onSqliteSnapshots: (facts) => {
          snapshotFacts = facts;
        },
      });
      postCoreRecovery.message += ` Archive retained for inspection at ${backup.archivePath}.`;
      assertCurrent();
      const requiredSnapshots: BackupSqliteSnapshotFact[] = [];
      const uncovered = pending.filter(({ database, identity }) => {
        const fact = snapshotFacts.find(
          (snapshot) =>
            snapshot.role === "agent" &&
            snapshot.agentId === database.agentId &&
            sameSnapshotFile(identity, snapshot),
        );
        if (!fact) {
          return true;
        }
        requiredSnapshots.push(fact);
        return false;
      });
      if (uncovered.length) {
        throw coverageRefusal(
          uncovered.map(({ database }) => database),
          `the retained archive at ${backup.archivePath} has no captured canonical image for these agent databases.`,
        );
      }
      await verifyBackupArchive(backup.archivePath, requiredSnapshots);
      assertCurrent();
      const current = await readDrivingUpdater();
      assertCurrent();
      if (current?.runId !== updater.runId || !current.postCoreStarted) {
        throw new UpdateSchemaRefusalError(blockedMigrations, updater.version, {
          targetVersion: VERSION,
          recovery: postCoreRecovery,
          cause: new Error(
            `Post-core admission changed; recovery backup remains at ${backup.archivePath}.`,
          ),
        });
      }
      // Carry verified coverage through later Doctor awaits to the canonical
      // versioned-write/commit owner, without fencing ordinary cleanup or rebuilds.
      maintenance.addAgentSchemaMigrationCheck((migration) => {
        authority.assertCurrent();
        const identity = statSync(migration.path, { throwIfNoEntry: false });
        if (
          !identity?.isFile() ||
          !requiredSnapshots.some(
            (fact) =>
              fact.role === "agent" &&
              fact.agentId === migration.agentId &&
              sameSnapshotFile(identity, fact),
          )
        ) {
          throw coverageRefusal(
            [{ kind: "agent", ...migration }],
            "agent database physical identity changed or has no verified snapshot before schema migration.",
          );
        }
      });
      (options.runtime ?? defaultRuntime).log(
        `Verified agent-schema recovery backup retained at ${backup.archivePath}.`,
      );
      return schemas;
    }
    // 2026.9.2 invokes this Doctor before discarding its package rollback.
    // Returning a rehearsal decision prevents every subsequent live Doctor writer.
    if (
      !recovery &&
      updater.earlyDoctorRunning &&
      !updater.postCoreStarted &&
      isUpdatePackageSwapInProgress(process.env) &&
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE === "1" &&
      process.env[POST_CORE_UPDATE_ENV] !== "1" &&
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART === "1" &&
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR === "0" &&
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION === "0" &&
      process.env.OPENCLAW_SERVICE_REPAIR_POLICY === "external"
    ) {
      // Refuse a known unsupported backup route while the shipped package driver
      // can still restore its old package. Post-core requires actual archive proof.
      const pending = capturePending();
      const registered = schemas.agentDatabaseMigrationDiscovery?.registeredAgentDatabases ?? [];
      const uncovered = pending.filter(
        ({ database, identity }) =>
          !registered.some((entry) => {
            if (entry.agentId !== database.agentId) {
              return false;
            }
            const current = statSync(entry.path, { throwIfNoEntry: false });
            return current?.isFile() && sameSnapshotFile(identity, current);
          }),
      );
      if (uncovered.length) {
        throw coverageRefusal(
          uncovered.map(({ database }) => database),
          "these pending agent databases have no registered canonical snapshot owner.",
        );
      }
      return {
        ...schemas,
        updateSchemaRehearsal: { runId: updater.runId, updaterVersion: updater.version },
      };
    }
  }
  const error = new UpdateSchemaRefusalError(blockedMigrations, updater.version, {
    targetVersion: VERSION,
    recovery,
  });
  if (recovery) {
    recordUpdateDoctorRefusal(error.message);
  }
  if (options.json) {
    const runtime = options.runtime ?? defaultRuntime;
    writeRuntimeJson(runtime, formatCliJsonFailure(error));
    exitCliAfterOutput(runtime, 1);
  }
  throw error;
}

/** Complete a private CLI validation before bootstrap can reach any live writer. */
export async function preflightUpdateDoctorCli(options: { json?: boolean }) {
  // Pin the invoking parent before schema admission can yield or reparent us.
  const parent = readUpdateRunDriver(process.ppid);
  const schemas = await guardUpdateDoctorSchemaUpgrade(options);
  if (schemas?.updateSchemaRehearsal) {
    await rehearseDeferredUpdateDoctorSchemaForParent(schemas, defaultRuntime, parent);
    // The existing one-shot owner joins cleanup and drains the warning before exit.
    exitCliAfterOutput(defaultRuntime, 0);
  }
  return schemas;
}

/** The shipped package validator may still roll back; it must never reach live Doctor writers. */
export function rehearseDeferredUpdateDoctorSchema(
  schemas: DoctorDatabasePreflight,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  return rehearseDeferredUpdateDoctorSchemaForParent(
    schemas,
    runtime,
    readUpdateRunDriver(process.ppid),
  );
}

async function rehearseDeferredUpdateDoctorSchemaForParent(
  schemas: DoctorDatabasePreflight,
  runtime: RuntimeEnv,
  parent: UpdateRunDriver | undefined,
): Promise<void> {
  const selected = schemas.updateSchemaRehearsal;
  if (!selected) {
    throw new Error("Missing legacy update schema rehearsal admission.");
  }
  if (!parent) {
    throw new Error("The schema rehearsal parent identity is unavailable.");
  }
  const assertParent = () => {
    const current = readUpdateRunDriver(process.ppid);
    if (!current || !sameUpdateRunDriver(current, parent)) {
      throw new Error("The schema rehearsal parent identity changed.");
    }
  };
  assertParent();
  const [
    { createConfigIO },
    { resolveOpenClawPackageRoot },
    { resolveUpdateInstallKind },
    { prepareUpdateCandidateRehearsal },
    { resolveGatewayInstallEntrypoint },
    { runUtf8CommandWithTimeout },
    { resolveSqliteInspectionBudget },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../infra/openclaw-root.js"),
    import("../infra/update-check.js"),
    import("../infra/update-candidate-rehearsal.js"),
    import("../daemon/gateway-entrypoint.js"),
    import("../process/exec.js"),
    import("../infra/sqlite-readonly-worker.js"),
  ]);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
  });
  const updater = await readDrivingUpdater();
  if (
    !root ||
    (await resolveUpdateInstallKind(root)) !== "package" ||
    updater?.runId !== selected.runId ||
    !updater.earlyDoctorRunning ||
    updater.postCoreStarted
  ) {
    throw new UpdateSchemaRefusalError(schemas.pendingMigrations ?? [], selected.updaterVersion, {
      targetVersion: VERSION,
      cause: new Error("The shipped package-validation handoff could not be verified."),
    });
  }
  assertParent();
  const entry = await resolveGatewayInstallEntrypoint(root);
  if (!entry) {
    throw new Error("Candidate Doctor entrypoint is unavailable for private schema validation.");
  }
  const snapshot = await createConfigIO({
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  assertParent();
  const rehearsal = await prepareUpdateCandidateRehearsal({
    candidateRoot: root,
    config: snapshot.sourceConfig ?? snapshot.config,
    stateDir: resolveStateDir(),
  });
  // Capture all producer-owned roots before an awaited inventory can retarget them.
  const cleanupRoots = new Map(
    rehearsal.cleanupDirectories.map((directory) => {
      const identity = lstatSync(directory);
      if (
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        realpathSync(directory) !== directory
      ) {
        throw new Error(`Private Doctor cleanup root is not physical; retained ${directory}.`);
      }
      return [directory, identity] as const;
    }),
  );
  const assertCleanupDirectory = (directory: string) => {
    const original = cleanupRoots.get(directory);
    const current = lstatSync(directory);
    if (
      !original ||
      !sameSnapshotFile(original, current) ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== original.uid ||
      realpathSync(directory) !== directory
    ) {
      throw new Error(`Private Doctor cleanup identity changed; inspect ${directory}.`);
    }
  };
  let failure: { error: unknown } | undefined;
  let settled = false;
  let writerStarted = false;
  let resourceWarnings: import("../plugins/doctor-contract-module.js").PluginDoctorMigrationBackupWarning[] =
    [];
  try {
    const env = { ...rehearsal.env, OPENCLAW_UPDATE_IN_PROGRESS: "0" };
    const { inspectPreparedDoctorRehearsal } =
      await import("./doctor-update-rehearsal-inventory.js");
    const admitted = await inspectPreparedDoctorRehearsal({
      stateDir: rehearsal.stateDir,
      pluginCodeLinks: rehearsal.pluginCodeLinks,
      env,
      assertCurrent: assertParent,
    });
    const current = await readDrivingUpdater();
    if (
      current?.runId !== selected.runId ||
      !current.earlyDoctorRunning ||
      current.postCoreStarted
    ) {
      throw new Error("The schema rehearsal updater changed before Doctor launch.");
    }
    resourceWarnings = admitted.fact.warnings;
    runtime.log(JSON.stringify(admitted.fact));
    admitted.assertPrepared();
    writerStarted = true;
    const result = await runUtf8CommandWithTimeout(
      [
        process.execPath,
        entry,
        "doctor",
        "--fix",
        "--non-interactive",
        "--no-workspace-suggestions",
      ],
      {
        cwd: root,
        baseEnv: env,
        timeoutMs: resolveSqliteInspectionBudget(
          "legacy update schema rehearsal",
          rehearsal.stateDir,
          rehearsal.snapshotCapacity.sqliteBytes,
        ).timeoutMs,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        // Doctor's exit owns validation; verbose diagnostics must not turn a
        // successful migration into an update refusal on a large agent fleet.
        outputCapture: { stdout: "discard", stderr: "tail" },
        maxOutputBytes: { stderr: 20_000 },
      },
    );
    settled = result.cleanup === "normal";
    if (!settled) {
      throw new Error(
        `Private Doctor did not settle; rehearsal retained at ${rehearsal.stateDir}.`,
      );
    }
    if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
      const { redactSupportString } = await import("../logging/diagnostic-support-redaction.js");
      throw new Error(
        `Private Doctor schema validation failed (${result.termination}): ${redactSupportString(result.stderr, { env, stateDir: rehearsal.stateDir }, { maxLength: 2000 })}`,
      );
    }
  } catch (error) {
    failure = { error };
  }
  if (settled || !writerStarted) {
    try {
      // Refuse the whole cleanup if ownership was already lost; the producer
      // rechecks each root again immediately before its individual removal.
      for (const directory of cleanupRoots.keys()) {
        assertCleanupDirectory(directory);
      }
      await rehearsal.cleanup(assertCleanupDirectory);
    } catch (cleanupError) {
      if (failure) {
        runtime.error(`Warning: Private Doctor cleanup was not completed: ${String(cleanupError)}`);
      } else {
        throw cleanupError;
      }
    }
  }
  if (failure) {
    throw failure.error;
  }
  const warning = `Validated schema repair on private copies for OpenClaw ${selected.updaterVersion}; live agent databases are unchanged. Repair is deferred to the fresh post-core updater.`;
  const { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, writeUpdatePostInstallDoctorResult } =
    await import("../infra/update-doctor-result.js");
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
  if (resultPath) {
    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: {
        status: "ok",
        configHash: "unchanged",
        warnings: [warning, ...resourceWarnings.map((resourceWarning) => resourceWarning.message)],
      },
    });
  }
  for (const resourceWarning of resourceWarnings) {
    runtime.error(`Warning: ${resourceWarning.message}`);
  }
  runtime.log(warning);
}
