import { randomUUID } from "node:crypto";
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BackupSqliteSnapshotFact } from "../../commands/backup-resource-inventory.js";
import { projectHeartbeatConfigForUpdateAdmission } from "../../commands/doctor-automatic-heartbeat-repair.js";
import { prepareDoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import {
  assertConfigFileWritePathSnapshot,
  captureConfigFileWritePathProof,
} from "../../config/io.write-safety.js";
import { resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import { withDoctorProgress } from "../../flows/doctor-health-startup.js";
import { runDoctorHealthFlow } from "../../flows/doctor-health.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "../../infra/directory-durability.js";
import { ignoreMissingPath } from "../../infra/errno.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "../../infra/json-files.js";
import { removePackageUpdatePath } from "../../infra/package-update-filesystem.js";
import { stateRootDirectoryMode } from "../../infra/private-dir-mode.js";
import {
  createUpdateDatabaseBackup,
  UpdateDatabaseBackupSchema,
} from "../../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../../infra/update-database-restore.js";
import {
  captureUpdateDoctorConfigWrites,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  UpdateDoctorDeferredInspectionCheckIdsSchema,
} from "../../infra/update-doctor-result.js";
import { createUpdateRun, recordUpdateRunDiagnostic } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { VERSION } from "../../version.js";
import { measureGatewayBootstrapStep } from "../startup-trace.js";
import {
  captureTargetDatabaseSchemaContext,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  captureUpdateConfigSnapshot,
  readUpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  // Receipts written before this field remain on disk and must stay finishable.
  startedAtMs: z.number().int().nonnegative().optional(),
  stateDir: z.string(),
  configPath: z.string(),
  status: z.enum(["backed-up", "migrated", "failed", "restoring-config", "restored", "finished"]),
  backup: UpdateDatabaseBackupSchema,
  databases: z.array(z.string()),
  databaseIdentities: z.record(z.string(), z.object({ dev: z.number(), ino: z.number() })),
  configIdentity: z.object({ path: z.string(), dev: z.number(), ino: z.number() }).nullable(),
  configFiles: z.array(
    z.object({
      path: z.string(),
      raw: z.string().nullable(),
      pathSnapshot: z.object({
        targetPath: z.string(),
        entries: z.array(
          z.discriminatedUnion("kind", [
            z.object({ path: z.string(), kind: z.literal("missing-directory") }),
            z.object({
              path: z.string(),
              kind: z.literal("existing"),
              dev: z.string(),
              ino: z.string(),
              link: z.string().optional(),
            }),
          ]),
        ),
      }),
    }),
  ),
  displacedConfigFiles: z.array(z.string()).optional(),
  configDisplacementHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  deferredInspectionCheckIds: UpdateDoctorDeferredInspectionCheckIdsSchema.optional(),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
});
type Receipt = z.infer<typeof ReceiptSchema>;
type FileIdentity = Pick<BackupSqliteSnapshotFact, "dev" | "ino">;

function receiptPath(backupRoot: string): string {
  if (!path.isAbsolute(backupRoot)) {
    throw new Error("--backup-root must be an absolute path.");
  }
  return `${path.resolve(backupRoot)}.receipt.json`;
}

async function readReceipt(backupRoot: string) {
  const file = receiptPath(backupRoot);
  const receipt = ReceiptSchema.parse(await readJsonIfExists(file));
  if (receipt.stateDir !== resolveStateDir() || receipt.configPath !== resolveConfigPath()) {
    throw new Error("Update migration receipt belongs to another state directory or config.");
  }
  const normalized = path.resolve(backupRoot);
  const canonicalBackup = path.join(
    await fs.realpath(path.dirname(normalized)),
    `${path.basename(normalized)}.databases`,
  );
  if (receipt.backup.directory !== canonicalBackup) {
    throw new Error("Update migration receipt belongs to another backup root.");
  }
  return { file, receipt };
}

async function saveReceipt(file: string, receipt: Receipt) {
  const destination = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  await writeJsonAtomic(destination, receipt, { mode: 0o600, dirMode: 0o700, durable: true });
}

async function readIdentities(databases: readonly string[]) {
  const identities: Record<string, FileIdentity> = {};
  for (const database of databases) {
    const info = await fs.stat(database, { bigint: true }).catch(ignoreMissingPath);
    if (info) {
      identities[database] = { dev: info.dev, ino: info.ino };
    }
  }
  return identities;
}

function toReceiptIdentities(
  identities: Record<string, FileIdentity>,
): Receipt["databaseIdentities"] {
  return Object.fromEntries(
    Object.entries(identities).map(([file, identity]) => [
      file,
      { dev: Number(identity.dev), ino: Number(identity.ino) },
    ]),
  );
}

async function readConfigIdentity(configPath: string): Promise<Receipt["configIdentity"]> {
  const identity = (await readIdentities([configPath]))[configPath];
  return identity
    ? { path: configPath, dev: Number(identity.dev), ino: Number(identity.ino) }
    : null;
}

/** The external supervisor owns drain/start; the candidate owns backup and schema repair. */
export async function updateMigrateCommand(
  backupRoot: string,
  options: { fullIntegrityCheck?: boolean } = {},
): Promise<void> {
  const startedAtMs = Date.now();
  const measure = <T>(phase: string, run: () => T | Promise<T>) =>
    withDoctorProgress(
      `Update migration ${phase.replaceAll("-", " ")}`,
      () => measureGatewayBootstrapStep(`update.migrate.${phase}`, run),
      true,
    );
  const file = receiptPath(backupRoot);
  if ((await readJsonIfExists(file)) !== null) {
    throw new Error(
      `Update migration receipt already exists: ${file}. Restore it or choose a new backup root.`,
    );
  }
  const env = process.env;
  // Validate Doctor's projection without retiring config before its state is backed up.
  const source = await measure("config-admission", () =>
    withArtifactPreservingStateReads(() =>
      captureTargetDatabaseSchemaContext(env, {
        validateConfigForAdmission: (snapshot) =>
          projectHeartbeatConfigForUpdateAdmission(snapshot, env, false),
      }),
    ),
  );
  const preflight = await measure("schema-preflight", () => prepareDoctorDatabasePreflight());
  if (hasSchemaRefusal(preflight)) {
    throw new Error(formatSchemaRefusalLines(preflight).join("\n"));
  }
  const lock = await acquireGatewayLock({
    env,
    role: "sqlite-maintenance",
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!lock) {
    throw new Error("Update migration requires the Gateway to be stopped.");
  }
  let receipt: Receipt;
  let verifiedSnapshots: BackupSqliteSnapshotFact[];
  try {
    ({ receipt, verifiedSnapshots } = await lock.run(async () => {
      await fs.mkdir(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
      lock.assertCurrent();
      const config = await captureUpdateConfigSnapshot(resolveConfigPath(env), env);
      if (config.doctorOwned === false) {
        throw new Error(
          "Update migration cannot capture the complete configuration include graph.",
        );
      }
      const normalized = path.resolve(backupRoot);
      const canonicalRoot = path.join(
        await fs.realpath(path.dirname(normalized)),
        path.basename(normalized),
      );
      lock.assertCurrent();
      const backup = await measure("database-backup", () =>
        createUpdateDatabaseBackup({
          backupRoot: canonicalRoot,
          stateDir: resolveStateDir(env),
          config: source.config,
          env,
          stopped: true,
        }),
      );
      lock.assertCurrent();
      const databases = [
        ...new Set([...backup.databases.map((entry) => entry.path), ...backup.missingPaths]),
      ];
      const databaseIdentities = await readIdentities(databases);
      lock.assertCurrent();
      const capturedReceipt: Receipt = {
        schemaVersion: 1,
        runId: randomUUID(),
        startedAtMs,
        stateDir: resolveStateDir(env),
        configPath: resolveConfigPath(env),
        status: "backed-up",
        backup,
        databases,
        databaseIdentities: toReceiptIdentities(databaseIdentities),
        configIdentity: await readConfigIdentity(resolveConfigPath(env)),
        configFiles: [config, ...(config.includedFiles ?? [])].map((entry) => {
          const pathSnapshot =
            entry.pathSnapshot ??
            captureConfigFileWritePathProof(
              entry.path,
              resolvePathViaExistingAncestorSync(entry.path),
              fsNode,
            ).snapshot;
          assertConfigFileWritePathSnapshot(pathSnapshot, fsNode);
          return { path: entry.path, raw: entry.raw, pathSnapshot };
        }),
      };
      await saveReceipt(file, capturedReceipt);
      lock.assertCurrent();
      const snapshots = (backup.databaseOwners ?? []).flatMap(
        (owner): BackupSqliteSnapshotFact[] => {
          const identity = databaseIdentities[owner.path];
          if (!identity) {
            return [];
          }
          return [{ sourcePath: owner.path, ...identity, ...owner }];
        },
      );
      return { receipt: capturedReceipt, verifiedSnapshots: snapshots };
    }));
  } finally {
    await lock.release();
  }
  // Update mode reuses this capture instead of creating a second standalone Doctor archive.
  // The supervisor retains service ownership and its admission fence through verification.
  const doctorEnv = {
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "reported-checks",
    // Native migration owns the in-process receipt, not an inherited parent IPC file.
    [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: "",
  };
  const previous = Object.fromEntries(Object.keys(doctorEnv).map((key) => [key, env[key]]));
  Object.assign(env, doctorEnv);
  try {
    preflight.verifiedSnapshots = verifiedSnapshots;
    await captureUpdateDoctorConfigWrites(receipt.configPath, async (capture) => {
      try {
        await runDoctorHealthFlow(
          defaultRuntime,
          {
            repair: true,
            nonInteractive: true,
            workspaceSuggestions: false,
            fullIntegrityCheck: options.fullIntegrityCheck,
          },
          undefined,
          preflight,
        );
      } catch (error) {
        if (!(error instanceof ExitError) || error.code !== 0) {
          throw error;
        }
      }
      receipt.deferredInspectionCheckIds = capture.deferredInspectionCheckIds;
      receipt.warnings = capture.warnings;
    });
    const migrated = await measure("schema-verification", () => prepareDoctorDatabasePreflight());
    if (hasSchemaRefusal(migrated) || migrated.pendingMigrations?.length) {
      throw new Error(
        "Doctor did not complete the candidate database migrations; the recovery backup was retained.",
      );
    }
    receipt.status = "migrated";
    receipt.databaseIdentities = toReceiptIdentities(await readIdentities(receipt.databases));
    receipt.configIdentity = await readConfigIdentity(receipt.configPath);
    await saveReceipt(file, receipt);
  } catch (error) {
    receipt.status = "failed";
    receipt.error = formatErrorMessage(error);
    await saveReceipt(file, receipt);
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
  defaultRuntime.writeJson({
    status: receipt.status,
    receipt: file,
    databases: receipt.databases,
    ...(receipt.warnings?.length ? { warnings: receipt.warnings } : {}),
  });
}

/** Rollback of a stopped, still-fenced candidate may discard its startup bookkeeping. */
export async function updateRestoreCommand(backupRoot: string): Promise<void> {
  const { file, receipt } = await readReceipt(backupRoot);
  if (receipt.status === "finished") {
    throw new Error("The accepted update's rollback backup has been retired.");
  }
  if (receipt.status !== "restored") {
    if (receipt.status !== "restoring-config") {
      await restoreUpdateDatabaseBackup({
        backup: receipt.backup,
        runId: receipt.runId,
        env: process.env,
        assertCurrent: () => {},
      });
      receipt.status = "restoring-config";
      receipt.databaseIdentities = toReceiptIdentities(await readIdentities(receipt.databases));
      await saveReceipt(file, receipt);
    }
    const lock = await acquireGatewayLock({
      env: process.env,
      role: "sqlite-maintenance",
      allowInTests: true,
      timeoutMs: 0,
    });
    if (!lock) {
      throw new Error("Configuration rollback requires the Gateway to remain stopped.");
    }
    try {
      await lock.run(async () => {
        for (const config of receipt.configFiles) {
          const assertCurrent = () => {
            lock.assertCurrent();
            assertConfigFileWritePathSnapshot(config.pathSnapshot, fsNode);
          };
          assertCurrent();
          const configPath = config.pathSnapshot.targetPath;
          const current = await readUpdateConfigSnapshot(configPath);
          assertCurrent();
          // Unchanged includes may be readable but intentionally not writable by the runtime.
          if (current.raw === config.raw) {
            continue;
          }
          const target = `${configPath}.migrated-${receipt.runId}`;
          const displaced = await readUpdateConfigSnapshot(target);
          assertCurrent();
          const expectedHash = receipt.configDisplacementHashes?.[target];
          if (displaced.raw !== null) {
            if (!expectedHash || displaced.hash !== expectedHash) {
              throw new Error(
                `Displaced configuration changed or has no recovery receipt: ${target}`,
              );
            }
            if (
              current.raw !== null &&
              current.raw !== config.raw &&
              current.hash !== expectedHash
            ) {
              throw new Error(
                `Configuration changed after rollback began: ${config.path}; newer bytes were preserved.`,
              );
            }
          } else if (current.raw !== null) {
            if (expectedHash && current.hash !== expectedHash) {
              throw new Error(
                `Configuration changed before rollback displacement: ${config.path}; newer bytes were preserved.`,
              );
            }
            (receipt.configDisplacementHashes ??= {})[target] = current.hash;
            await saveReceipt(file, receipt);
            // Keep the selected config readable until its original is atomically restored.
            const staged = `${target}.pending-${randomUUID()}`;
            try {
              await writeTextAtomic(staged, current.raw, {
                mode: 0o600,
                dirMode: stateRootDirectoryMode(path.dirname(staged), receipt.stateDir),
                durable: true,
              });
              const identity = await fs.lstat(staged);
              assertCurrent();
              await publishFileExclusive({
                sourcePath: staged,
                targetPath: target,
                expectedSourceIdentity: identity,
                strategy: "rename-noreplace",
              });
            } finally {
              await fs.rm(staged, { force: true });
            }
            assertCurrent();
          } else if (expectedHash) {
            throw new Error(`The recorded configuration displacement is missing: ${target}`);
          }
          if (
            (displaced.raw !== null || current.raw !== null) &&
            !receipt.displacedConfigFiles?.includes(target)
          ) {
            (receipt.displacedConfigFiles ??= []).push(target);
          }
          if (config.raw !== null) {
            await writeTextAtomic(configPath, config.raw, {
              mode: 0o600,
              dirMode: stateRootDirectoryMode(path.dirname(configPath), receipt.stateDir),
              durable: true,
              beforeRename: async () => assertCurrent(),
            });
          } else {
            assertCurrent();
            await fs.rm(configPath, { force: true });
            const directory = await fs.realpath(path.dirname(configPath));
            assertCurrent();
            requireDirectorySync(
              await syncDirectory(directory),
              "Restored configuration directory",
            );
            assertCurrent();
          }
        }
      });
    } finally {
      await lock.release();
    }
    receipt.status = "restored";
    receipt.databaseIdentities = toReceiptIdentities(await readIdentities(receipt.databases));
    receipt.configIdentity = await readConfigIdentity(receipt.configPath);
    delete receipt.error;
    await saveReceipt(file, receipt);
  }
  defaultRuntime.writeJson({ status: receipt.status, receipt: file, databases: receipt.databases });
}

/** The supervisor calls this only after accepting the candidate and retiring its rollback journal. */
export async function updateFinishCommand(backupRoot: string): Promise<void> {
  const { file, receipt } = await readReceipt(backupRoot);
  if (receipt.status !== "migrated" && receipt.status !== "finished") {
    throw new Error("Only a successfully migrated and accepted update may retire its backup.");
  }
  receipt.status = "finished";
  receipt.configFiles = [];
  await saveReceipt(file, receipt);
  const removed = await removePackageUpdatePath(receipt.backup.directory);
  const warnings = [
    ...(receipt.warnings ?? []),
    ...(removed
      ? []
      : [`Backup cleanup remains pending at ${receipt.backup.directory}; retry update finish.`]),
  ];
  // Cleanup retires rollback originals only after a later update succeeds. Starting the
  // run at migration keeps originals from this update's own Doctor run protected; a
  // receipt without its start time cannot prove that ordering and is not recorded.
  if (receipt.startedAtMs !== undefined) {
    try {
      const recorded = createUpdateRun(
        {
          runId: receipt.runId,
          trigger: "cli",
          accepted: { startedAtMs: receipt.startedAtMs },
          after: { version: VERSION },
        },
        { env: process.env },
      );
      for (const [index, warning] of (receipt.warnings ?? []).entries()) {
        recordUpdateRunDiagnostic(
          receipt.runId,
          warning,
          { env: process.env },
          `warning:doctor:${index}`,
        );
      }
      if (receipt.deferredInspectionCheckIds?.length) {
        const pendingStep = "warning:post-activation doctor inspections";
        recordUpdateRunDiagnostic(
          receipt.runId,
          "Deferred Doctor inspections are pending; retry update finish if interrupted.",
          { env: process.env },
          pendingStep,
        );
        const [
          { readConfigFileSnapshot },
          { updateRunStepsFromResultStep },
          { waitForGatewayHttpReadiness },
          { resolveUpdateRoot },
          { runPostActivationInspections },
        ] = await Promise.all([
          import("../../config/config.js"),
          import("../../infra/update-run-step.js"),
          import("../daemon-cli/restart-health-probe.js"),
          import("./shared.js"),
          import("./update-command-post-activation-inspections.js"),
        ]);
        const root = await resolveUpdateRoot();
        const { config } = await readConfigFileSnapshot();
        const readiness = await waitForGatewayHttpReadiness({
          config,
          port: resolveGatewayPort(config),
          attempts: 1,
          deadlineAt: performance.now() + 3_000,
          delayMs: 0,
          requireChannelHealth: false,
        });
        const result = await runPostActivationInspections({
          root,
          gatewayReady: readiness.coreReady === true,
          result: {
            status: "ok",
            mode: "unknown",
            durationMs: 0,
            steps: [
              {
                name: "openclaw doctor",
                command: "doctor --repair",
                cwd: root,
                durationMs: 0,
                exitCode: 0,
                deferredInspectionCheckIds: receipt.deferredInspectionCheckIds,
              },
            ],
          },
        });
        const inspection = result.steps.at(-1)!;
        const complete = inspection.deferredInspectionCheckIds?.length === 0;
        // Replace earlier retry warnings while preserving bounded lint findings in status.
        const diagnostics = new Map(
          recorded.steps
            .filter((step) => step.step.startsWith(`warning:${inspection.name}`))
            .map((step) => [step.step, ""]),
        );
        diagnostics.set(pendingStep, "");
        diagnostics.set(inspection.name, "");
        for (const step of updateRunStepsFromResultStep(inspection)) {
          if (step.detail !== undefined) {
            diagnostics.set(step.step, step.detail);
          }
        }
        // Retire the pending warning last, after the findings are durable.
        const settledWarning = diagnostics.get(pendingStep)!;
        diagnostics.delete(pendingStep);
        diagnostics.set(pendingStep, settledWarning);
        for (const [step, detail] of diagnostics) {
          recordUpdateRunDiagnostic(receipt.runId, detail, { env: process.env }, step);
        }
        warnings.push(
          ...(inspection.warnings ??
            [inspection.advisory?.message].filter((message): message is string =>
              Boolean(message),
            )),
        );
        if (complete) {
          receipt.deferredInspectionCheckIds = [];
          await saveReceipt(file, receipt);
        } else {
          warnings.push("Deferred Doctor inspections remain pending; retry update finish.");
        }
      }
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      warnings.push(
        `Update history or deferred inspections did not complete for this accepted update (${formatErrorMessage(error)}); retry update finish.`,
      );
    }
  }
  defaultRuntime.writeJson({
    status: receipt.status,
    receipt: file,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  });
}
