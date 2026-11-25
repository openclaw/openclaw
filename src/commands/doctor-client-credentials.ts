import fs from "node:fs";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { preparePostgresClientCredentials } from "./startup-client-credentials.js";

/** Runs under Doctor's maintenance owner; startup never grants this identity change. */
export async function prepareDoctorClientCredentials(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  prompter: DoctorPrompter;
  maintenanceActive: boolean;
  schemas: DoctorDatabasePreflight;
}): Promise<boolean> {
  if (!isStatePostgres() || !fs.existsSync(resolveOpenClawStateSqlitePath())) {
    return true;
  }
  // A missing local store before cutover is an identity-preserving migration.
  if (
    params.schemas.pendingMigrations?.some(
      (entry) =>
        entry.kind === "state" && entry.foundVersion < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
    )
  ) {
    if (params.maintenanceActive) {
      await preparePostgresClientCredentials(process.env, params.runtime);
    }
    return true;
  }
  let present: boolean;
  {
    using local = openClientCredentialCustody(process.env, { readOnly: true, migration: true });
    present = local !== undefined;
  }
  if (present) {
    if (params.maintenanceActive) {
      await preparePostgresClientCredentials(process.env, params.runtime);
    }
    return true;
  }
  params.runtime.log(
    "Local client credentials are missing. Repair gives clients on this host new identities, so they must re-pair. Paired remote devices keep working; their pairing records stay in PostgreSQL.",
  );
  const approved =
    params.maintenanceActive &&
    (params.options.repair === true || params.options.yes === true) &&
    (params.options.yes === true ||
      (await params.prompter.confirmRuntimeRepair({
        message: "Create new local client identities?",
        initialValue: false,
        requiresInteractiveConfirmation: true,
      })));
  if (!approved) {
    params.runtime.log("Local credentials were not repaired. Run openclaw doctor --fix --yes.");
    return false;
  }
  await preparePostgresClientCredentials(process.env, params.runtime, true);
  return true;
}
