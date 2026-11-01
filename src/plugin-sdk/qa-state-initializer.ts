/** Current-package synthetic fixtures only; existing installations still use Doctor. */
export async function initializeQaRuntimeState(): Promise<void> {
  const env = process.env;
  const [
    { createConfigIO },
    { replaceConfigFile },
    { listAgentIds },
    { openOpenClawStateDatabase },
    { withOpenClawAgentDatabaseAsync },
    { applyPluginAutoEnable },
    { migrateLegacyConfigMachineState },
    { initializeFreshDaemonRuntimePinMigration },
    { refreshPluginRegistry },
    { applyPluginDoctorCompatibilityMigrations },
    { prepareSharedAuthStoreOwnership },
    { detectSharedAuthStoreMigration, migrateSharedAuthStore },
    { resolveStateDir },
    { maybeMigrateModelCatalogCredentials },
    { createDoctorPrompter },
    { defaultRuntime },
    { migrateLegacyMainSessionKeys },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../config/mutate.js"),
    import("../agents/agent-roster.js"),
    import("../state/openclaw-state-db.js"),
    import("../state/openclaw-agent-db.js"),
    import("../config/plugin-auto-enable.js"),
    import("../infra/state-migrations.config-machine-state.js"),
    import("../infra/state-migrations.daemon-runtime-pins.js"),
    import("../plugins/plugin-registry-refresh.js"),
    import("../plugins/doctor-contract-registry.js"),
    import("../agents/auth-profiles/path-resolve.js"),
    import("../infra/state-migrations.shared-auth-store.js"),
    import("../config/paths.js"),
    import("../commands/doctor-model-catalog-credentials.js"),
    import("../commands/doctor-prompter.js"),
    import("../runtime.js"),
    import("../config/sessions/legacy-main-session-migration.js"),
  ]);
  const io = createConfigIO({ env, observe: false });
  const snapshot = await io.readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("QA initializer requires a valid current-package fixture config");
  }
  openOpenClawStateDatabase({ env });
  await prepareSharedAuthStoreOwnership(env);
  const stateDir = resolveStateDir(env);
  const sharedAuth = await migrateSharedAuthStore({
    detected: detectSharedAuthStoreMigration({
      stateDir,
      env,
      config: snapshot.sourceConfig,
      doctorOnlyStateMigrations: true,
    }),
    stateDir,
    env,
  });
  if (sharedAuth.warnings.length) {
    throw new Error(sharedAuth.warnings.join("\n"));
  }
  const machineState = migrateLegacyConfigMachineState({ config: snapshot.sourceConfig, env });
  if (machineState.warnings.length) {
    throw new Error(machineState.warnings.join("\n"));
  }
  initializeFreshDaemonRuntimePinMigration(env);
  const migration = applyPluginDoctorCompatibilityMigrations(snapshot.sourceConfig, {
    env,
    historicalWebhookListeners: "preserve-configured",
  });
  if (migration.warnings?.length) {
    throw new Error(migration.warnings.join("\n"));
  }
  const config = applyPluginAutoEnable({
    config: migration.config,
    env,
  }).config;
  const credentials = await maybeMigrateModelCatalogCredentials({
    cfg: config,
    env,
    prompter: createDoctorPrompter({
      runtime: defaultRuntime,
      options: { repair: true, nonInteractive: true },
    }),
    runtime: defaultRuntime,
  });
  if (credentials.warnings.length) {
    throw new Error(credentials.warnings.join("\n"));
  }
  await replaceConfigFile({
    io: { ...io, env },
    snapshot,
    sourceConfig: config,
    afterWrite: { mode: "auto" },
  });
  // Config writes advance existing health baselines; fresh fixtures need their first observation.
  await createConfigIO({ env }).readConfigFileSnapshot();
  for (const agentId of listAgentIds(config)) {
    await withOpenClawAgentDatabaseAsync({ agentId, env }, () => undefined);
  }
  const legacySessions = await migrateLegacyMainSessionKeys({
    cfg: config,
    env,
    mode: "doctor-fix",
  });
  if (legacySessions.warnings.length) {
    throw new Error(legacySessions.warnings.join("\n"));
  }
  if (legacySessions.armed && (!legacySessions.complete || !legacySessions.ledgerComplete)) {
    throw new Error("QA initializer requires completed legacy session migration");
  }
  await refreshPluginRegistry({ config, env, reason: "manual" });
}
