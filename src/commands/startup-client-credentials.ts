import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareClientCredentialStoreAsync } from "../infra/client-credential-async.js";
import {
  ClientCredentialMigrationRequiredError,
  readClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "../infra/exec-approvals-migration-gate.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

/** Inspect all required inputs before maintenance can create a store or migrate shared schema. */
async function prepareRequiredLegacyClientCredentials(env: NodeJS.ProcessEnv) {
  const [
    { prepareLegacyDeviceIdentity },
    { prepareLegacyDeviceAuth },
    { prepareLegacyExecApprovals, readLegacyExecApprovalsPreparationFacts },
    { resolveClientCredentialLegacyImportClaims },
    { executeSqliteQuerySync, getNodeSqliteKysely },
    { tableExists },
    { readStateSchemaContentVersion },
    { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION },
    {
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
    },
    { withEngineStoreAdmission },
    { isStatePostgres },
    { resolveExecApprovalsPath },
  ] = await Promise.all([
    import("../infra/state-migrations.device-identity.js"),
    import("../infra/state-migrations.device-auth.js"),
    import("../infra/state-migrations.exec-approvals.js"),
    import("../infra/client-credential-migration-data.js"),
    import("../infra/kysely-sync.js"),
    import("../state/openclaw-state-db-schema-helpers.js"),
    import("../state/openclaw-state-db-schema-version.js"),
    import("../state/openclaw-state-db-contract.js"),
    import("../state/openclaw-state-db-readonly.js"),
    import("../infra/database-engine/admission-scope.js"),
    import("../state/openclaw-state-db-engine.js"),
    import("../infra/exec-approvals-config.js"),
  ]);
  type CredentialDatabase = import("../infra/client-credential-schema.js").ClientCredentialDatabase;
  type CredentialClaims =
    import("../infra/client-credential-receipt.js").ClientCredentialReceipt["legacyImports"];
  const readIdentities = (database: EngineConnection) =>
    tableExists(database, "device_identities")
      ? executeSqliteQuerySync(
          database,
          getNodeSqliteKysely<CredentialDatabase>(database)
            .selectFrom("device_identities")
            .selectAll()
            .where("identity_key", "in", ["primary", "node", "shareExtension"]),
        ).rows
      : [];
  let identities: CredentialDatabase["device_identities"][] = [];
  let legacyImports: CredentialClaims = {};
  {
    using owner = openClientCredentialCustody(env, { readOnly: true, migration: true });
    if (owner) {
      identities = readIdentities(owner.database);
      legacyImports = readClientCredentialReceipt(owner.database)?.receipt.legacyImports ?? {};
    }
  }
  const readSource = ({ db }: { db: EngineConnection }) => {
    const version = readStateSchemaContentVersion(db);
    const predecessor = version < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION;
    const sourceIdentities = predecessor ? readIdentities(db) : undefined;
    return {
      identities: sourceIdentities,
      legacyImports: sourceIdentities
        ? resolveClientCredentialLegacyImportClaims(db, {
            identities: sourceIdentities,
            nativeBootstrap: version === 0,
            authTablePresent: version !== 0 || tableExists(db, "device_auth_tokens"),
          })
        : {},
      approvals: readLegacyExecApprovalsPreparationFacts(db, resolveExecApprovalsPath(env)),
    };
  };
  // PostgreSQL boot admission is synchronous; SQLite snapshot preparation may await.
  const source = isStatePostgres()
    ? withEngineStoreAdmission(() =>
        withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(readSource, { env }),
      )
    : await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(readSource, { env });
  identities = source?.identities ?? identities;
  legacyImports = { ...source?.legacyImports, ...legacyImports };
  const stateDir = resolveStateDir(env);
  let detectedIdentity: Awaited<ReturnType<typeof prepareLegacyDeviceIdentity>>;
  try {
    detectedIdentity = await prepareLegacyDeviceIdentity({
      stateDir,
      identities,
      legacyImports,
    });
    await prepareLegacyDeviceAuth({ stateDir, legacyImports });
  } catch (error) {
    throw new ClientCredentialMigrationRequiredError(
      `Legacy client credentials require migration: ${String(error)}`,
    );
  }
  await prepareLegacyExecApprovals({ stateDir, env, facts: source?.approvals });
  return detectedIdentity;
}

async function readCredentialPreparationState(
  env: NodeJS.ProcessEnv,
): Promise<"ready" | "upgrade" | "required"> {
  try {
    assertNoPendingLegacyExecApprovals({ env });
    return await prepareClientCredentialStoreAsync(env);
  } catch (error) {
    if (
      error instanceof ClientCredentialMigrationRequiredError ||
      error instanceof ExecApprovalsMigrationRequiredError
    ) {
      return "required";
    }
    throw error;
  }
}

/** Complete the selected root's cutover before any client acquires credentials. */
export async function prepareStartupClientCredentials(
  params: {
    env?: NodeJS.ProcessEnv;
    runtime?: RuntimeEnv;
    config?: OpenClawConfig;
  } = {},
): Promise<void> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const preparation = await readCredentialPreparationState(env);
  if (preparation === "ready") {
    return;
  }
  const runtime = params.runtime ?? defaultRuntime;
  const [{ createConfigIO }, { resolveDatabaseEngineSelection }, { withDatabaseEngineSelection }] =
    await Promise.all([
      import("../config/io.js"),
      import("../infra/database-engine/config.js"),
      import("../infra/database-engine/context.js"),
    ]);
  // Config supplies the engine, not a different migration target or process-wide environment.
  const engineEnv = cloneEnvWithPlatformSemantics(env);
  let config = params.config;
  if (!config) {
    const snapshot = await createConfigIO({
      env: engineEnv,
      configPath: resolveConfigPath(env),
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error(`Cannot prepare client credentials with invalid config at ${snapshot.path}.`);
    }
    config = snapshot.config;
  }
  // Gateway recovery may have validated a backup before its lease-owned application.
  const selection = await resolveDatabaseEngineSelection(config, engineEnv);
  await withDatabaseEngineSelection(selection, async () => {
    if (preparation === "required") {
      await prepareRequiredLegacyClientCredentials(env);
    }
    const { beginDoctorMaintenance } = await import("./doctor-maintenance.js");
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    try {
      maintenance = await beginDoctorMaintenance({
        env,
        root: null,
        options: { repair: true, nonInteractive: true },
        waitForMaintenance: preparation === "required",
        // JSONL node workers reserve stdout for their protocol.
        runtime: { ...runtime, log: runtime.error },
      });
    } catch (error) {
      const [
        { collectNestedErrorCandidates },
        { GatewayStateOwnerContentionError },
        { DoctorMaintenanceRefusalError },
        { hasCommandProcessCleanupError },
        { resolveCommandProcessSignal },
      ] = await Promise.all([
        import("../infra/error-graph-internal.js"),
        import("../infra/gateway-state-owner.js"),
        import("../infra/update-doctor-result.js"),
        import("../process/exec-result.js"),
        import("../process/exec-spawn.js"),
      ]);
      const causes = collectNestedErrorCandidates(error);
      const optionalUpgrade =
        preparation === "upgrade" && error instanceof DoctorMaintenanceRefusalError;
      if (
        !causes.some((cause) => cause instanceof AggregateError) &&
        !hasCommandProcessCleanupError(error) &&
        (optionalUpgrade ||
          causes.some((cause) => cause instanceof GatewayStateOwnerContentionError)) &&
        (await readCredentialPreparationState(env)) !== "required"
      ) {
        resolveCommandProcessSignal()?.throwIfAborted();
        if (optionalUpgrade) {
          runtime.error(
            "Client credential metadata upgrade deferred; existing credentials remain available. Startup will retry automatically.",
          );
        }
        // Admission has settled. A peer may have completed required recovery meanwhile.
        return;
      }
      throw error;
    }
    if (!maintenance) {
      throw new Error("Client credential preparation requires maintenance ownership.");
    }
    try {
      await maintenance.run(async () => {
        const currentPreparation = await readCredentialPreparationState(env);
        if (currentPreparation === "ready") {
          return;
        }
        const preparedIdentity =
          currentPreparation === "required"
            ? await prepareRequiredLegacyClientCredentials(env)
            : undefined;
        const { prepareOpenClawStateDatabaseSchema } =
          await import("../state/openclaw-state-db.js");
        const { isStatePostgres } = await import("../state/openclaw-state-db-engine.js");
        if (isStatePostgres()) {
          await preparePostgresClientCredentials(env, runtime);
        } else {
          const result = await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
          for (const warning of result.warnings) {
            runtime.error(warning);
          }
        }
        const [identity, auth, approvals] = await Promise.all([
          import("../infra/state-migrations.device-identity.js"),
          import("../infra/state-migrations.device-auth.js"),
          import("../infra/state-migrations.exec-approvals.js"),
        ]);
        const context = { env, stateDir: resolveStateDir(env), doctorOnlyStateMigrations: true };
        const detectedIdentity = preparedIdentity ?? identity.detectLegacyDeviceIdentity(context);
        if (detectedIdentity.hasInvalidCanonical) {
          throw new Error(
            "Invalid client identity requires explicit repair; startup preserved it.",
          );
        }
        for (const migrate of [
          () => identity.migrateLegacyDeviceIdentity({ ...context, detected: detectedIdentity }),
          () =>
            auth.migrateLegacyDeviceAuth({
              ...context,
              detected: auth.detectLegacyDeviceAuth(context),
            }),
          () =>
            approvals.migrateLegacyExecApprovals({
              ...context,
              detected: approvals.detectLegacyExecApprovals(context),
            }),
        ]) {
          for (const warning of (await migrate()).warnings) {
            runtime.error(warning);
          }
        }
        if ((await readCredentialPreparationState(env)) !== "ready") {
          throw new ClientCredentialMigrationRequiredError();
        }
      });
    } finally {
      await maintenance.release();
    }
  });
}

export async function preparePostgresClientCredentials(
  env: NodeJS.ProcessEnv,
  runtime: RuntimeEnv,
  rebindMissing = false,
) {
  const [
    preflight,
    { prepareDoctorDatabaseMigrations },
    { withEngineStoreAdmission },
    state,
    credentials,
  ] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("./doctor-schema-migrations.js"),
    import("../infra/database-engine/admission-scope.js"),
    import("../state/openclaw-state-db.js"),
    import("../infra/client-credential-migration.js"),
  ]);
  const schemas = await preflight.preflightOpenClawDatabaseSchemas({ env, scope: "state" });
  if (schemas.incompatible.length) {
    throw new preflight.OpenClawDatabaseSchemaPreflightError(schemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadable = schemas.indeterminate.find((entry) => entry.kind === "state");
  if (unreadable) {
    throw new Error(`Cannot prepare client credentials: ${unreadable.reason}`);
  }
  const migrations = schemas.pendingMigrations?.filter((entry) => entry.kind === "state") ?? [];
  if (migrations.length) {
    const paths = migrations.map((entry) => entry.path);
    const result = await prepareDoctorDatabaseMigrations({
      env,
      pendingDatabasePaths: paths,
      pendingMigrations: migrations,
      databasePaths: paths,
    });
    for (const warning of result.warnings) {
      runtime.error(warning);
    }
  }
  withEngineStoreAdmission(() => {
    const source = state.openOpenClawStateDatabase({ env });
    const result = credentials.recoverClientCredentialStore(source.db, {
      env,
      path: source.path,
      rebindMissing,
    });
    if (result === "rebound") {
      runtime.error(
        "Local client credentials were missing and have been re-created for the existing PostgreSQL state store. Clients on this host have new identities and must pair again; paired remote devices that kept their credentials stay paired.",
      );
    }
  });
}
