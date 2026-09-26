import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.js";

export type DoctorDatabasePreflight = OpenClawDatabaseSchemaPreflight & {
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  agentDatabaseRecoveryConfigValid?: boolean;
  updateSchemaRehearsal?: { runId: string; updaterVersion: string };
};

/** Prepare fleet facts through the artifact-preserving schema readers. */
export async function prepareDoctorDatabasePreflight(
  options: { scope?: "state"; cfg?: OpenClawConfig } = {},
): Promise<DoctorDatabasePreflight> {
  const { scope } = options;
  const databasePreflight = await import("../state/openclaw-database-preflight.js");
  const [
    { createConfigIO },
    targets,
    { listAgentIds, resolveAgentDir },
    { openDoctorStateSchemaReadAdmission },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../config/sessions/targets.js"),
    import("../agents/agent-scope-config.js"),
    import("../state/openclaw-state-db-doctor-schema.js"),
  ]);
  const snapshot =
    scope === "state" || options.cfg
      ? undefined
      : await createConfigIO({
          env: { ...process.env },
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
  const cfg =
    scope === "state" ? undefined : (options.cfg ?? snapshot?.sourceConfig ?? snapshot?.config);
  let agentDatabaseMigrationDiscovery: PreparedAgentDatabaseMigrationDiscovery | undefined;
  const databaseSchemas = await databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
    scope,
    openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    ...(cfg
      ? {
          // Custom stores go through the artifact-preserving header reader; discovery
          // must not open live SQLite files before the update guard.
          configuredAgentDatabaseTargets: listAgentIds(cfg).map((agentId) => ({
            agentId,
            path: path.join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
          })),
          configuredAgentDatabaseCandidatePaths:
            targets.resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env: process.env }),
          agentAdmissionConfig: cfg,
          onAgentDatabaseDiscovery: (prepared: PreparedAgentDatabaseMigrationDiscovery) => {
            agentDatabaseMigrationDiscovery = prepared;
          },
        }
      : {}),
  });
  if (databaseSchemas.incompatible.length > 0) {
    throw new databasePreflight.OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadableStateDatabase = databaseSchemas.indeterminate.find(
    (database) => database.kind === "state",
  );
  if (unreadableStateDatabase) {
    throw new DoctorUnreadableStateDatabaseError(
      unreadableStateDatabase.path,
      unreadableStateDatabase.reason,
    );
  }
  return {
    ...databaseSchemas,
    ...(agentDatabaseMigrationDiscovery
      ? {
          agentDatabaseMigrationDiscovery,
          // Supplied configs do not validate a captured ownership inventory.
          agentDatabaseRecoveryConfigValid: snapshot?.valid === true,
        }
      : {}),
  };
}
