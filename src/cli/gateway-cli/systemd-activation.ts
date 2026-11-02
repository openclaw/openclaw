import { prepareDoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../../infra/startup-maintenance-required.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.types.js";
import { readOwnGatewayServiceCommand } from "../run-main-service-installation.js";

function assertRepairable(schemas: OpenClawDatabaseSchemaPreflight): void {
  const problems = [
    ...schemas.indeterminate.map((entry) => `${entry.path}: ${entry.reason}`),
    ...(schemas.agentRefusals ?? []).map((entry) => entry.reason),
  ];
  if (problems.length) {
    throw new StartupMaintenanceRequiredError(
      "state-migrations",
      `Systemd activation left unverifiable state unchanged. Run openclaw doctor to inspect it.\n${problems.join("\n")}`,
    );
  }
}

/** The running unit owns activation; Doctor owns offline custody, backups and migrations. */
export async function prepareSystemdGatewayActivation(params: {
  runtime: RuntimeEnv;
  beforeStatePreparation: () => Promise<boolean>;
}): Promise<void> {
  if (
    process.platform !== "linux" ||
    process.env.OPENCLAW_SERVICE_MARKER !== "openclaw" ||
    process.env.OPENCLAW_SERVICE_KIND !== "gateway" ||
    !(await readOwnGatewayServiceCommand(process.env))
  ) {
    return;
  }
  try {
    // Header inspection keeps healthy restarts out of Doctor maintenance entirely.
    const initial = await prepareDoctorDatabasePreflight();
    if (!initial.pendingMigrations?.length) {
      return;
    }
    assertRepairable(initial);
    if (!(await params.beforeStatePreparation())) {
      throw new Error("Systemd activation config changed before repair; retry startup.");
    }
    params.runtime.log("Systemd activation: backing up and migrating older OpenClaw databases.");
    const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
    // A null install root deliberately excludes service stop/install/start. This
    // process is already the unit's MainPID; only systemd may control its lifecycle.
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true, nonInteractive: true },
      runtime: params.runtime,
    });
    if (!maintenance) {
      throw new Error("Systemd activation requires Doctor maintenance ownership.");
    }
    try {
      await maintenance.run(async () => {
        const schemas = await prepareDoctorDatabasePreflight();
        assertRepairable(schemas);
        if (!schemas.pendingMigrations?.length) {
          return;
        }
        if (!(await params.beforeStatePreparation())) {
          throw new Error("Systemd activation config changed before repair; retry startup.");
        }
        const discovery = schemas.agentDatabaseMigrationDiscovery;
        const targets = discovery?.discovery.schemaTargets ?? [];
        const { prepareDoctorDatabaseMigrations } =
          await import("../../commands/doctor-schema-migrations.js");
        const report = (result: { changes: string[]; warnings: string[] }) => {
          for (const change of result.changes) {
            params.runtime.log(change);
          }
          // A completed migration can still warn about bookkeeping. Ordinary
          // startup admission decides readiness after Doctor releases custody.
          for (const warning of result.warnings) {
            params.runtime.error(warning);
          }
        };
        const prepared = await prepareDoctorDatabaseMigrations({
          env: process.env,
          databasePaths: targets.map((target) => target.path),
          agentDatabaseTargets: targets,
          pendingDatabasePaths: schemas.pendingMigrations.map((entry) => entry.path),
          pendingMigrations: schemas.pendingMigrations,
        });
        report(prepared);
        if (discovery) {
          discovery.versionMigrations = prepared.versionMigrations;
        }
        // Older migrations without a scoped version phase retain Doctor's full
        // backup and canonical migration owners, including retained media data.
        const { prepareOpenClawStateDatabaseSchema } =
          await import("../../state/openclaw-state-db.js");
        const { migrateLegacyMediaPersistence } =
          await import("../../infra/state-migrations.media-persistence.js");
        report(await prepareOpenClawStateDatabaseSchema({ env: process.env }, "doctor"));
        report(
          await migrateLegacyMediaPersistence({ env: process.env, preparedDiscovery: discovery }),
        );
      });
    } finally {
      await maintenance.release();
    }
  } catch (error) {
    if (findStartupMaintenanceRequiredError(error)) {
      throw error;
    }
    // Existing deployed units park exit 78; an unsuccessful activation must not
    // retry offline repair in a Restart=always loop.
    throw new StartupMaintenanceRequiredError(
      "state-migrations",
      `Systemd activation repair failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}
