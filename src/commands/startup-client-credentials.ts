import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareClientCredentialStoreAsync } from "../infra/client-credential-async.js";
import {
  ClientCredentialMigrationRequiredError,
  readClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
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
  const retainedApprovals = await prepareLegacyExecApprovals({
    stateDir,
    env,
    facts: source?.approvals,
  });
  return { detectedIdentity, retainedApprovals };
}

async function readCredentialPreparationState(
  env: NodeJS.ProcessEnv,
  retainedApprovals = false,
): Promise<"ready" | "upgrade" | "required"> {
  try {
    if (!retainedApprovals) {
      assertNoPendingLegacyExecApprovals({ env });
    }
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

/**
 * A running Gateway holds the state this required migration must change. Native startup uses
 * the code to explain that Gateway's owner instead of attributing every failure to it.
 */
export class ClientCredentialGatewayHeldError extends Error {
  readonly code = "client_credentials_gateway_held";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ClientCredentialGatewayHeldError";
  }
}

/** Complete the selected root's cutover before any client acquires credentials. */
export async function prepareStartupClientCredentials(
  params: {
    env?: NodeJS.ProcessEnv;
    runtime?: RuntimeEnv;
    config?: OpenClawConfig;
    /** Native startup must settle service intent before choosing a Gateway runtime. */
    prepareRuntimePins?: boolean;
  } = {},
): Promise<void> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const preparation = await readCredentialPreparationState(env);
  if (preparation === "ready" && !params.prepareRuntimePins) {
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
    if (preparation === "ready") {
      return;
    }
    let retainedApprovals = false;
    if (preparation === "required") {
      retainedApprovals = Boolean(
        (await prepareRequiredLegacyClientCredentials(env)).retainedApprovals,
      );
      if (retainedApprovals && (await readCredentialPreparationState(env, true)) === "ready") {
        return;
      }
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
        (await readCredentialPreparationState(env, retainedApprovals)) !== "required"
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
      const gatewayHeld = causes.some(
        (cause) =>
          cause instanceof GatewayStateOwnerContentionError && cause.holder?.role === "gateway",
      );
      if (
        gatewayHeld &&
        !causes.some((cause) => cause instanceof AggregateError) &&
        !hasCommandProcessCleanupError(error)
      ) {
        throw new ClientCredentialGatewayHeldError(error);
      }
      throw error;
    }
    if (!maintenance) {
      throw new Error("Client credential preparation requires maintenance ownership.");
    }
    try {
      await maintenance.run(async () => {
        const currentPreparation = await readCredentialPreparationState(env, retainedApprovals);
        if (currentPreparation === "ready") {
          return;
        }
        const prepared =
          currentPreparation === "required"
            ? await prepareRequiredLegacyClientCredentials(env)
            : undefined;
        retainedApprovals = Boolean(prepared?.retainedApprovals) || retainedApprovals;
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
        const detectedIdentity =
          prepared?.detectedIdentity ?? identity.detectLegacyDeviceIdentity(context);
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
            retainedApprovals
              ? { warnings: [] }
              : approvals.migrateLegacyExecApprovals({
                  ...context,
                  detected: withEngineStoreAdmission(() =>
                    approvals.detectLegacyExecApprovals(context),
                  ),
                }),
        ]) {
          for (const warning of (await migrate()).warnings) {
            runtime.error(warning);
          }
        }
        if ((await readCredentialPreparationState(env, retainedApprovals)) !== "ready") {
          throw new ClientCredentialMigrationRequiredError();
        }
      });
    } finally {
      await maintenance.release();
    }
  });
  if (params.prepareRuntimePins) {
    // Credential cutover may advance shared state beyond the old seeded Gateway.
    // Release Doctor custody first; the daemon owner admits its own offline migration
    // under native service custody, preserving explicit pins and refusing conflicts.
    // Run even when credentials were already ready after an interrupted first launch.
    const { withDaemonRuntimePinMigration } = await import("../daemon/runtime-pin-state.js");
    await withDatabaseEngineSelection(selection, () =>
      withDaemonRuntimePinMigration(env, () => undefined),
    );
  }
}

export async function preparePostgresClientCredentials(
  env: NodeJS.ProcessEnv,
  runtime: RuntimeEnv,
  rebindMissing = false,
) {
  const [
    preflight,
    { prepareDoctorDatabaseMigrations },
    state,
    { prepareClientCredentialRecoveryCustody, recoverClientCredentialStore },
  ] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("./doctor-schema-migrations.js"),
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
  const source = withEngineStoreAdmission(() => state.openOpenClawStateDatabase({ env }));
  const prepared = await prepareClientCredentialRecoveryCustody({
    env,
    path: source.path,
    rebindMissing,
  });
  try {
    const recover = () =>
      withEngineStoreAdmission(() =>
        recoverClientCredentialStore(source.db, {
          env,
          path: source.path,
          rebindMissing,
          recovery: prepared,
        }),
      );
    const result = prepared
      ? await (
          await import("../infra/update-doctor-migration-attribution.js")
        ).runUpdateSqliteMigrationAsync(prepared.custody.database, prepared.custody.path, recover, {
          retainExclusive: true,
        })
      : recover();
    if (result === "rebound") {
      runtime.error(
        "Local client credentials were missing and have been re-created for the existing PostgreSQL state store. Clients on this host have new identities and must pair again; paired remote devices that kept their credentials stay paired.",
      );
    }
  } finally {
    prepared?.custody.close();
  }
}
