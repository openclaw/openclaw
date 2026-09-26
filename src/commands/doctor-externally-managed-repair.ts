/** Offline Doctor repair for deployments that own config and service lifecycle. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { withSuppressedNotes } from "../../packages/terminal-core/src/note.js";
import { resolveConfigPath } from "../config/paths.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import type { DoctorOptions } from "./doctor.types.js";

const REPORT_SCHEMA_VERSION = 1 as const;

type AppliedRepair = {
  stepId: string;
  changes: string[];
};

type RemainingRepair = {
  stepId: string;
  message: string;
};

export type ExternallyManagedDoctorRepairReport = {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  mode: "externally-managed";
  ok: boolean;
  config: {
    path: string;
    status: "unchanged";
    sha256: string | null;
  };
  service: {
    status: "externally-managed";
  };
  applied: AppliedRepair[];
  skipped: Array<{ scope: "config" | "service"; reason: string }>;
  remaining: RemainingRepair[];
};

function readConfigBytes(pathname: string): Buffer | undefined {
  try {
    return fs.readFileSync(pathname);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sha256(value: Buffer | undefined): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

function collectReceiptEvidence(
  receipts: readonly LegacyStateMigrationStepReceipt[] | undefined,
  applied: AppliedRepair[],
  remaining: RemainingRepair[],
): void {
  for (const receipt of receipts ?? []) {
    if (receipt.changes.length > 0) {
      applied.push({ stepId: receipt.id, changes: [...receipt.changes] });
    }
    for (const warning of receipt.warnings) {
      remaining.push({ stepId: receipt.id, message: warning });
    }
    if (receipt.outcome === "refused" && receipt.warnings.length === 0) {
      remaining.push({
        stepId: receipt.id,
        message: receipt.refusal?.message ?? "Repair was refused.",
      });
    }
  }
}

/**
 * Repairs writable runtime state while leaving deployment-owned config and service
 * lifecycle untouched. The caller must stop the Gateway before invoking this mode.
 */
export async function runExternallyManagedDoctorRepair(params: {
  options: DoctorOptions;
  runtime: RuntimeEnv;
  databasePreflight?: DoctorDatabasePreflight;
}): Promise<ExternallyManagedDoctorRepairReport> {
  const configPath = resolveConfigPath();
  const configBefore = readConfigBytes(configPath);
  const applied: AppliedRepair[] = [];
  const remaining: RemainingRepair[] = [];
  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const { beginDoctorMaintenance } = await import("./doctor-maintenance.js");
  const maintenance = await beginDoctorMaintenance({
    options: params.options,
    root,
    runtime: params.runtime,
  });
  if (!maintenance) {
    throw new Error("Externally managed Doctor repair could not enter maintenance mode.");
  }

  let config:
    | Awaited<
        ReturnType<typeof import("./doctor-config-preflight.js").runDoctorConfigPreflight>
      >["baseConfig"]
    | undefined;
  let failure: unknown;
  try {
    await maintenance.run(async () => {
      let schemas =
        params.databasePreflight ??
        (await (await import("./doctor-database-preflight.js")).prepareDoctorDatabasePreflight());
      const {
        repairOpenClawStateDatabaseIndexesForDoctor,
        repairOpenClawStateDatabaseReadabilityForDoctor,
      } = await import("../state/openclaw-state-db.js");
      for (const repair of [
        repairOpenClawStateDatabaseIndexesForDoctor,
        repairOpenClawStateDatabaseReadabilityForDoctor,
      ]) {
        const result = repair({ env: process.env });
        if (result.warnings.length > 0) {
          remaining.push(
            ...result.warnings.map((message) => ({ stepId: "shared-state", message })),
          );
        }
        if (result.changes.length > 0) {
          applied.push({ stepId: "shared-state", changes: [...result.changes] });
          schemas = await (
            await import("./doctor-database-preflight.js")
          ).prepareDoctorDatabasePreflight();
        }
      }

      const backups = await (
        await import("./doctor-migration-backup.js")
      ).backupDoctorMigrationDatabases({
        env: process.env,
        pendingDatabasePaths: schemas.pendingMigrations?.map((database) => database.path) ?? [],
      });
      if (backups.changes.length > 0) {
        applied.push({ stepId: "database-backup", changes: backups.changes });
      }
      remaining.push(
        ...backups.warnings.map((message) => ({ stepId: "database-backup", message })),
      );
      if (backups.warnings.length > 0) {
        return;
      }

      const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
      const preflight = await withSuppressedNotes(() =>
        runDoctorConfigPreflight({
          invocationPurpose: "doctor",
          migrateLegacyConfig: false,
          repairPrefixedConfig: false,
          recoverCorruptTargetStore: true,
          doctorOnlyStateMigrations: true,
          preparePluginMetadataSnapshot: true,
          ...(schemas.agentDatabaseMigrationDiscovery
            ? { agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery }
            : {}),
        }),
      );
      config = preflight.baseConfig;
      collectReceiptEvidence(preflight.stateMigrationStepReceipts, applied, remaining);

      if (!preflight.snapshot.valid) {
        remaining.push({
          stepId: "config",
          message:
            "Externally managed config requires changes. Update the deployment source, redeploy it, then rerun Doctor repair.",
        });
        return;
      }

      const sessionWarnings: string[] = [];
      const sessionReceipt = await withSuppressedNotes(() =>
        import("./doctor-session-transcripts.js").then(({ noteSessionTranscriptHealth }) =>
          noteSessionTranscriptHealth({
            cfg: preflight.baseConfig,
            env: process.env,
            shouldRepair: true,
            ...(preflight.postSessionPluginMigration
              ? { postSessionPluginMigration: preflight.postSessionPluginMigration }
              : {}),
            ...(preflight.postSessionPluginMigrationPlanBound
              ? { postSessionPluginMigrationPlanBound: true }
              : {}),
            onWarnings: (warnings) => sessionWarnings.push(...warnings),
          }),
        ),
      );
      collectReceiptEvidence(sessionReceipt ? [sessionReceipt] : [], applied, remaining);
      remaining.push(...sessionWarnings.map((message) => ({ stepId: "session-state", message })));
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await maintenance.finish(config, undefined, failure);
    } finally {
      await maintenance.release();
    }
  }

  const configAfter = readConfigBytes(configPath);
  if (!Buffer.from(configAfter ?? []).equals(Buffer.from(configBefore ?? []))) {
    throw new Error(
      "Externally managed Doctor repair changed deployment-owned config; repair stopped without reporting success.",
    );
  }
  const dedupedRemaining = remaining.filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) => candidate.stepId === entry.stepId && candidate.message === entry.message,
      ) === index,
  );
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: "externally-managed",
    ok: dedupedRemaining.length === 0,
    config: { path: configPath, status: "unchanged", sha256: sha256(configAfter) },
    service: { status: "externally-managed" },
    applied,
    skipped: [
      {
        scope: "config",
        reason: "Deployment-owned config is read-only in this repair posture.",
      },
      {
        scope: "service",
        reason: "The deployment supervisor owns Gateway stop and start.",
      },
    ],
    remaining: dedupedRemaining,
  };
}
