import { prepareDoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import { acquireWithWait } from "../../infra/acquire-with-wait.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS } from "../../infra/gateway-lock.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../../infra/startup-maintenance-required.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.types.js";
import { isOpenClawStateWriteContentionError } from "../../state/openclaw-state-ownership.js";
import { readOwnGatewayServiceCommand } from "../run-main-service-installation.js";

const ACTIVATION_CONTENTION_RETRY_MS = 5_000;

/** Another process holds state for now; only a retry can tell whether repair still applies. */
function isTransientStateContention(error: unknown): boolean {
  const causes = collectNestedErrorCandidates(error);
  if (
    causes.some(
      (cause) =>
        cause instanceof DoctorMaintenanceRefusalError && cause.refusal.kind !== "deferred",
    )
  ) {
    return false;
  }
  return causes.some(
    (cause) =>
      isOpenClawStateWriteContentionError(cause) ||
      (cause instanceof DoctorMaintenanceRefusalError &&
        cause.refusal.kind === "deferred" &&
        cause.refusal.reason === "agent-database-in-use"),
  );
}

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
    // Doctor waits out recorded CLI holders on its own deadline, which can exceed
    // this one. Unidentified holders retry here, which keeps starts under the limit.
    let announcedWait = false;
    const maintenance = await acquireWithWait({
      acquire: async () => {
        const owner = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: params.runtime,
          waitForMaintenance: true,
        });
        if (!owner) {
          throw new Error("Systemd activation requires Doctor maintenance ownership.");
        }
        return owner;
      },
      shouldRetry: (error) => {
        const retry = isTransientStateContention(error);
        if (retry && !announcedWait) {
          announcedWait = true;
          params.runtime.log(
            "Systemd activation: OpenClaw state is busy; waiting for it to be released.",
          );
        }
        return retry;
      },
      deadlineMs: performance.now() + GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS,
      pollIntervalMs: ACTIVATION_CONTENTION_RETRY_MS,
    });
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
        const report = (result: { changes: string[]; warnings: string[]; failure?: unknown }) => {
          for (const change of result.changes) {
            params.runtime.log(change);
          }
          // A completed migration can still warn about bookkeeping. Ordinary
          // startup admission decides readiness after Doctor releases custody.
          for (const warning of result.warnings) {
            params.runtime.error(warning);
          }
          // A blocked repair changed nothing, and admission would park it as unrepaired.
          if (isTransientStateContention(result.failure)) {
            throw result.failure;
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
    if (isTransientStateContention(error)) {
      // Nothing is wrong with this state, so exit 78 would strand a healthy service.
      // Restart=always retries; the unit's start limit bounds repeated repair attempts.
      params.runtime.error(
        `Systemd activation: OpenClaw state is still busy; exiting so systemd retries. ${formatErrorMessage(error)}`,
      );
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
