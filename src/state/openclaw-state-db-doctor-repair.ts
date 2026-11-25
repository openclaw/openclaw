import { existsSync } from "node:fs";
import {
  withStateDatabaseSchemaMaintenance,
  withStateDatabaseSchemaMaintenanceAsync,
} from "../infra/state-database-maintenance.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { repairStateSchema, repairStateSchemaAsync } from "./openclaw-state-db-repair.js";
import { assertOpenClawStateSchemaRepairAllowed } from "./openclaw-state-db-schema-policy.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

type DoctorRepairScope = "doctor" | "indexes" | "readability" | "version";
type DoctorRepairOptions = OpenClawStateDatabaseOptions & { integrityCheck?: "quick" | "full" };

function resolveDoctorRepairTarget(options: DoctorRepairOptions, scope: DoctorRepairScope) {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  assertOpenClawStateSchemaRepairAllowed(pathname);
  if (!existsSync(pathname)) {
    return undefined;
  }
  if (scope === "readability") {
    // A writer close may checkpoint WAL and invalidate a recorded corruption refusal.
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  }
  return { pathname, env };
}

export function repairDoctorStateSchema(options: DoctorRepairOptions, scope: DoctorRepairScope) {
  const target = resolveDoctorRepairTarget(options, scope);
  return target
    ? withStateDatabaseSchemaMaintenance({ databasePath: target.pathname }, () =>
        repairStateSchema(target.pathname, target.env, scope, options.integrityCheck),
      )
    : { changes: [], warnings: [] };
}

export async function repairDoctorStateSchemaAsync(
  options: DoctorRepairOptions,
  scope: DoctorRepairScope,
): Promise<{ changes: string[]; warnings: string[]; failure?: unknown }> {
  const target = resolveDoctorRepairTarget(options, scope);
  return target
    ? withStateDatabaseSchemaMaintenanceAsync({ databasePath: target.pathname }, () =>
        repairStateSchemaAsync(target.pathname, target.env, scope, options.integrityCheck),
      )
    : { changes: [], warnings: [] };
}
