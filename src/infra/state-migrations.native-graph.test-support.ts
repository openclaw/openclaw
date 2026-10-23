import { expect, vi } from "vitest";

// Load one native migration graph before the suite and after resetModules.
export async function importStateMigrationFixtureGraph() {
  const { readAcpSessionMetaForEntry } = await import("../acp/runtime/session-meta-readonly.js");
  const { AgentSelectionRequiredError, resolveDefaultAgentId } =
    await import("../agents/agent-scope.js");
  const { assertWorkspaceStateMigrationReady } =
    await import("../agents/workspace-legacy-state.js");
  const { readWorkspaceStateSnapshot } = await import("../agents/workspace-state-store.js");
  const { createChannelIngressQueue } = await import("../channels/message/ingress-queue.js");
  const { retainLegacyDefaultAgentId } = await import("../config/legacy.default-agent-owner.js");
  const { loadSessionEntryReadOnly, upsertSessionEntryCore } =
    await import("../config/sessions/session-accessor.js");
  const { writeSessionEntry } =
    await import("../config/sessions/session-accessor.sqlite-entry-store.js");
  const { readMemoryHostEventRecords } = await import("../memory-host-sdk/events.js");
  const { loadNodeHostConfig } = await import("../node-host/config.js");
  const { readChannelPairingStateSnapshot } =
    await import("../pairing/pairing-store-sqlite.test-helpers.js");
  const { definePluginDoctorMigrationFromPlans } =
    await import("../plugin-sdk/runtime-doctor-migrations.js");
  const { EMPTY_LEGACY_SESSION_SURFACES } =
    await import("../plugins/legacy-session-surfaces.types.js");
  const { resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../plugins/runtime.js");
  const { readConfigMachineState } = await import("../state/config-machine-state.js");
  const { listOpenClawRegisteredAgentDatabases } =
    await import("../state/openclaw-agent-db-registry.js");
  const {
    closeOpenClawAgentDatabasesAsync,
    closeOpenClawAgentDatabasesForTest,
    ensureOpenClawAgentDatabaseSchema,
    OPENCLAW_AGENT_SCHEMA_VERSION,
    runOpenClawAgentWriteTransaction,
  } = await import("../state/openclaw-agent-db.js");
  const { OPENCLAW_STATE_SCHEMA_VERSION } = await import("../state/openclaw-state-db-contract.js");
  const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
    await import("../state/openclaw-state-db.js");
  const { resolveOpenClawStateSqlitePath } = await import("../state/openclaw-state-db.paths.js");
  const { withStateMigrationBackupForTest } =
    await import("../state/openclaw-state-schema.test-support.js");
  const { createChannelTestPluginBase, createTestRegistry } =
    await import("../test-utils/channel-plugins.js");
  const { closeDatabaseTestCohorts, closeStateDatabaseForTest } =
    await import("../test-utils/database-cleanup.js");
  const { acquireGatewayLock } = await import("./gateway-lock.js");
  const { executeSqliteQuerySync, getNodeSqliteKysely } = await import("./kysely-sync.js");
  const { loadApnsRegistration } = await import("./push-apns.js");
  const { acquireStartupMigrationLeaseWithWait } =
    await import("./startup-migration-checkpoint.js");
  const { migrateDaemonRuntimePins } = await import("./state-migrations.daemon-runtime-pins.js");
  const {
    autoMigrateLegacyState: autoMigrateLegacyStateWithSurfaces,
    detectLegacyStateMigrations: detectLegacyStateMigrationsWithSurfaces,
    runLegacyStateMigrations: runLegacyStateMigrationsWithSurfaces,
  } = await import("./state-migrations.doctor.js");
  const { expectMissingPath } = await import("./state-migrations.filesystem.test-support.js");
  const { expectRecoveryPredicateRefusedAfterRepair } =
    await import("./state-migrations.ingress-lifecycle.test-support.js");
  const { createLegacyAuditLedger } =
    await import("./state-migrations.legacy-audit.test-support.js");
  const sessionStore = await import("./state-migrations.legacy-session-store.js");
  const { throwIfDoctorStateMigrationRefused } = await import("./state-migrations.messages.js");
  const { autoMigrateLegacyPluginDoctorState } =
    await import("./state-migrations.plugin-doctor.js");
  const {
    createConfig,
    createEnv,
    createLegacyAcpSessionEntry,
    createMigrationContext,
    drainSessionMigrationFixture,
  } = await import("./state-migrations.session-store.test-support.js");
  return {
    readAcpSessionMetaForEntry,
    AgentSelectionRequiredError,
    resolveDefaultAgentId,
    assertWorkspaceStateMigrationReady,
    readWorkspaceStateSnapshot,
    createChannelIngressQueue,
    retainLegacyDefaultAgentId,
    loadSessionEntryReadOnly,
    upsertSessionEntryCore,
    writeSessionEntry,
    readMemoryHostEventRecords,
    loadNodeHostConfig,
    readChannelPairingStateSnapshot,
    definePluginDoctorMigrationFromPlans,
    EMPTY_LEGACY_SESSION_SURFACES,
    resetPluginRuntimeStateForTest,
    setActivePluginRegistry,
    readConfigMachineState,
    listOpenClawRegisteredAgentDatabases,
    closeOpenClawAgentDatabasesAsync,
    closeOpenClawAgentDatabasesForTest,
    ensureOpenClawAgentDatabaseSchema,
    OPENCLAW_AGENT_SCHEMA_VERSION,
    runOpenClawAgentWriteTransaction,
    OPENCLAW_STATE_SCHEMA_VERSION,
    closeOpenClawStateDatabaseForTest,
    openOpenClawStateDatabase,
    resolveOpenClawStateSqlitePath,
    withStateMigrationBackupForTest,
    createChannelTestPluginBase,
    createTestRegistry,
    closeDatabaseTestCohorts,
    closeStateDatabaseForTest,
    acquireGatewayLock,
    executeSqliteQuerySync,
    getNodeSqliteKysely,
    loadApnsRegistration,
    acquireStartupMigrationLeaseWithWait,
    migrateDaemonRuntimePins,
    autoMigrateLegacyStateWithSurfaces,
    detectLegacyStateMigrationsWithSurfaces,
    runLegacyStateMigrationsWithSurfaces,
    expectMissingPath,
    expectRecoveryPredicateRefusedAfterRepair,
    createLegacyAuditLedger,
    sessionStore,
    throwIfDoctorStateMigrationRefused,
    autoMigrateLegacyPluginDoctorState,
    createConfig,
    createEnv,
    createLegacyAcpSessionEntry,
    createMigrationContext,
    drainSessionMigrationFixture,
  };
}

type StateMigrationFixtureGraph = Awaited<ReturnType<typeof importStateMigrationFixtureGraph>>;

export async function rerunStateMigrationFixtureAfterRestart(
  params: Parameters<StateMigrationFixtureGraph["autoMigrateLegacyStateWithSurfaces"]>[0],
  native: StateMigrationFixtureGraph,
  migrationDatabaseClosers: Set<() => void | Promise<void>>,
) {
  await native.closeDatabaseTestCohorts(migrationDatabaseClosers);
  vi.resetModules();
  const [agentDb, stateDb, agentDbTest] = await Promise.all([
    import("../state/openclaw-agent-db.js"),
    import("../state/openclaw-state-db.js"),
    import("../state/openclaw-agent-db.test-support.js"),
  ]);
  migrationDatabaseClosers.add(agentDb.closeOpenClawAgentDatabasesAsync);
  migrationDatabaseClosers.add(agentDb.closeOpenClawAgentDatabasesForTest);
  migrationDatabaseClosers.add(stateDb.closeOpenClawStateDatabaseAsync);
  migrationDatabaseClosers.add(stateDb.closeOpenClawStateDatabaseForTest);
  try {
    const migrationOwner = await import("./state-migrations.doctor.js");
    return await migrationOwner.autoMigrateLegacyState({
      legacySessionSurfaces: native.EMPTY_LEGACY_SESSION_SURFACES,
      ...params,
    });
  } finally {
    await native.closeDatabaseTestCohorts(migrationDatabaseClosers);
    expect(agentDbTest.listOpenClawAgentDatabasesForTest()).toEqual([]);
    expect(stateDb.isOpenClawStateDatabaseOpen()).toBe(false);
  }
}
