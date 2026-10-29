import assert from "node:assert/strict";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentIds } from "../agents/agent-roster.js";
import { inspectSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { inspectAuthProfileJsonCellReadOnly } from "../agents/auth-profiles/sqlite.js";
import {
  assertConfiguredWorkspaceStateReady,
  listWorkspaceStateDirs,
} from "../agents/workspace-state-dirs.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { readConfigHealthStateInDatabase } from "../config/io.health-state.kernel.js";
import type { ConfigHealthFingerprint } from "../config/io.health-state.types.js";
import { createConfigIO } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { resolveStateDir } from "../config/paths.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import {
  readStoredCanonicalSessionMainKey,
  scanCanonicalSqliteSessionEntries,
} from "../config/sessions/session-canonical-key.js";
import { hasPendingCanonicalSessionValidation } from "../config/sessions/session-canonical-validation.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import {
  readDaemonRuntimePinMigrationReceipt,
  withDaemonRuntimePinStore,
  type DaemonRuntimePinDatabase,
} from "../daemon/runtime-pin-store.js";
import { readClientCredentialBootstrapSource } from "../infra/client-credential-migration.js";
import { readClientCredentialReceipt } from "../infra/client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import type { ClientCredentialDatabase } from "../infra/client-credential-schema.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { assertNoPendingLegacyExecApprovals } from "../infra/exec-approvals-migration-gate.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readRestartSentinelRowSync } from "../infra/restart-sentinel-store.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { canSettleInterruptedUpdate } from "../infra/update-run-interruption-store.js";
import { readInterruptedUpdateCandidate, readUpdateRuns } from "../infra/update-run-read.kernel.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { inspectRecoveryRows } from "../infra/update-run-recovery-store.js";
import { readBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { resolvePluginRegistryContent } from "../plugins/plugin-registry-comparison.js";
import { inspectPluginRegistry } from "../plugins/plugin-registry-snapshot.js";
import { readRetainedAgentDeletionsFromDatabase } from "../state/agent-deletion-journal.read.js";
import type { AgentDatabaseDeletionWorkerSnapshot } from "../state/agent-deletion-journal.types.js";
import { loadOpenClawAgentCanonicalValidationReceipt } from "../state/openclaw-agent-canonical-validation-receipt.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { getOpenClawAgentDatabaseValidation } from "../state/openclaw-agent-db-validation-cache.js";
import type { DB as AgentDB } from "../state/openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { getStateRuntimeSchemaAdmission } from "../state/openclaw-state-db-admission.js";
import { assertExistingOpenClawStateRuntimeSchema } from "../state/openclaw-state-db-existing-schema.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB as StateDB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { inspectOpenClawStateOwnershipFromDatabase } from "../state/openclaw-state-ownership.js";
import { readStateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";

function normalizeFixture(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(root, "<fixture>").replace(/sk-qa-mock-[a-f0-9]+/gu, "<mock-key>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFixture(entry, root));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(root, "<fixture>"),
        normalizeFixture(entry, root),
      ]),
    );
  }
  return value;
}

/** Observe closed synthetic fixtures; never initialize, repair, or normalize away readiness. */
export async function collectQaStartupState(env: NodeJS.ProcessEnv) {
  assert.ok(
    env.OPENCLAW_STATE_DIR && env.OPENCLAW_CONFIG_PATH,
    "Explicit QA fixture paths required",
  );
  const stateDir = resolveStateDir(env);
  const root = path.dirname(stateDir);
  const statePath = resolveOpenClawStateSqlitePath(env);
  const config = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
  assert.ok(config.valid, "QA fixture config must be valid");
  const raw = config.raw;
  assert.ok(typeof raw === "string", "QA fixture config must exist");
  assertNoPendingLegacyExecApprovals({ env });
  assert.equal(hasActiveStartupMigrationLease({ env }), false, "Startup lease remains active");
  const registered = await inspectOpenClawRegisteredAgentDatabases({ env, path: statePath });
  assertSessionStoreMigrationComplete({
    cfg: config.sourceConfig,
    env,
    registeredDatabases: registered,
  });
  await assertConfiguredWorkspaceStateReady({ cfg: config.sourceConfig, env });
  const sharedCleanClose = readSqliteDatabaseCleanClose(statePath);
  using shared = openNodeSqliteDatabase(statePath, { readOnly: true });
  // Seals accelerate startup; the canonical reader also admits valid unsealed stores.
  assertExistingOpenClawStateRuntimeSchema(shared, statePath);
  const startupReady = getStateRuntimeSchemaAdmission(shared)?.startupReady;
  assert.equal(startupReady, true, "Shared state must be ready for startup");
  assert.equal(readStateSchemaPublicationBlocker(shared), undefined, "Schema publication blocked");
  assert.equal(readUpdateRuns(shared, { active: true, limit: 1 }).length, 0);
  assert.equal(
    inspectRecoveryRows(shared).some(({ record }) => isUpdateRecoveryPending(record)),
    false,
  );
  const interrupted = readInterruptedUpdateCandidate(shared);
  assert.equal(Boolean(interrupted && canSettleInterruptedUpdate(interrupted)), false);
  const sentinel = readRestartSentinelRowSync(shared);
  assert.equal(sentinel.kind, "missing", "Fresh fixture must not have a restart notification");
  const workspaces = [];
  for (const dir of await listWorkspaceStateDirs({
    cfg: config.sourceConfig,
    env,
    homedir: os.homedir,
    stateDir,
  })) {
    const snapshot = await readWorkspaceStateSnapshot(dir, { env, readOnly: true });
    workspaces.push({
      path: snapshot.identity.workspacePath,
      setupExists: snapshot.setupExists,
      setup: snapshot.setup,
      setupUpdatedAtMs: snapshot.setupUpdatedAtMs,
      attestation: snapshot.attestation && {
        ...snapshot.attestation,
        generatedHashes: [...snapshot.attestation.generatedHashes].toSorted(([a], [b]) =>
          a.localeCompare(b),
        ),
      },
    });
  }
  const deletedAgents: AgentDatabaseDeletionWorkerSnapshot["deletedAgents"] = [];
  const deletionJournal = readRetainedAgentDeletionsFromDatabase(
    shared,
    statePath,
    "runtime",
    deletedAgents,
  );
  const sharedDb = getNodeSqliteKysely<StateDB>(shared);
  const machineState = executeSqliteQuerySync(
    shared,
    sharedDb
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .orderBy("state_key"),
  ).rows.map(({ state_key, value_json }) => ({
    key: state_key,
    value: JSON.parse(value_json) as unknown,
  }));
  const index = await readPersistedInstalledPluginIndex({
    env,
    filePath: statePath,
    artifactPreservingReadOnly: true,
  });
  assert.ok(index, "Installed plugin metadata must parse");
  assert.ok(
    Number.isSafeInteger(index.generatedAtMs) && index.generatedAtMs > 0,
    "Plugin index generation must be recorded",
  );
  const inspection = await inspectPluginRegistry({
    config: config.sourceConfig,
    env,
    filePath: statePath,
    artifactPreservingReadOnly: true,
  });
  assert.equal(inspection.state, "fresh", "Plugin metadata must match the packaged runtime");
  const pluginIndex = {
    content: resolvePluginRegistryContent(index, true),
    sourceAdmissions: index.plugins.map(({ pluginId, sourceAdmissions }) => ({
      pluginId,
      sourceAdmissions,
    })),
  };
  const machines = machineState
    // Current fresh schemas do not consult these Doctor bookkeeping timestamps.
    .filter(
      ({ key }) =>
        key !== "config.lastTouchedAt" &&
        key !== "state.repair.acpReplayUtf8Accounting" &&
        // update-result-claim.ts records update-run provenance, not startup policy.
        key !== "telemetry.updateResults",
    )
    .map((row) => {
      if (row.key !== "plugins.installedIndex") {
        return row;
      }
      assert.ok(row.value && typeof row.value === "object" && "revision" in row.value);
      assert.ok(
        Number.isSafeInteger(row.value.revision),
        "Plugin metadata revision must be recorded",
      );
      // Revision and generation time describe this refresh, not the indexed startup policy.
      return { key: row.key, value: pluginIndex };
    });
  const auth = (kind: "agent" | "shared-state", pathname: string) => {
    const target = { kind, path: pathname, env };
    const store = inspectAuthProfileJsonCellReadOnly(target, "store");
    const state = inspectAuthProfileJsonCellReadOnly(target, "state");
    assert.notEqual(store.status, "unreadable", "Auth store must be readable");
    assert.notEqual(state.status, "unreadable", "Auth state must be readable");
    return { store, state };
  };
  const agents = [];
  const agentCleanClose = [];
  for (const agentId of listAgentIds(config.sourceConfig).toSorted()) {
    const pathname = resolveOpenClawAgentSqlitePath({ agentId, env });
    agentCleanClose.push({ agentId, cleanClose: readSqliteDatabaseCleanClose(pathname) });
    let version: number;
    {
      using native = openNodeSqliteDatabase(pathname, { readOnly: true });
      assertSqliteIntegrity(native, pathname);
      assertOpenClawAgentDatabaseForMaintenance(native, { agentId, pathname });
      version = readSqliteUserVersion(native);
    }
    const opened = openOpenClawAgentDatabaseReadOnly({ agentId, env, path: pathname });
    assert.ok(opened.found, `Configured agent database missing: ${agentId}`);
    const database = opened.database;
    try {
      const validation = getOpenClawAgentDatabaseValidation(database);
      if (validation) {
        assert.equal(Atomics.load(new Int32Array(validation.valid), 0), 1);
        assert.equal(Atomics.load(new Int32Array(validation.canonicalReady), 0), 1);
      }
      const db = getNodeSqliteKysely<AgentDB>(database.db);
      const canonicalReceipt = loadOpenClawAgentCanonicalValidationReceipt(database);
      // Fresh empty stores are admitted without a durable canonical-validation receipt.
      const canonicalEntries = scanCanonicalSqliteSessionEntries(database);
      assert.equal(hasPendingCanonicalSessionValidation(database), false);
      agents.push({
        agentId,
        version,
        canonicalReceipt,
        canonicalEntries,
        mainKey: readStoredCanonicalSessionMainKey(database),
        // This cursor belongs to Doctor; canonical startup admission is asserted above.
        schema: executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("schema_meta")
            .select(["meta_key", "role", "schema_version", "agent_id", "app_version"])
            .orderBy("meta_key"),
        ).rows.filter(({ meta_key }) => meta_key !== "historical-transcript-directives-v1"),
        auth: auth("agent", pathname),
      });
    } finally {
      database.close();
    }
  }
  const legacySessions = await migrateLegacyMainSessionKeys({
    cfg: config.sourceConfig,
    env,
    mode: "detect",
  });
  assert.deepEqual(legacySessions.warnings, [], "Legacy session migration must have no warnings");
  if (legacySessions.armed) {
    assert.equal(legacySessions.complete, true, "Legacy session migration must be complete");
    assert.equal(
      legacySessions.ledgerComplete,
      true,
      "Legacy session ledger must match current stores",
    );
  }
  using custody = openClientCredentialCustody(env, { readOnly: true });
  assert.ok(custody, "Native credential custody must exist");
  assert.equal(custody.needsMetadataUpgrade, false);
  const clientReceipt = readClientCredentialReceipt(custody.database);
  assert.equal(clientReceipt?.phase, "complete");
  assert.ok(clientReceipt);
  assert.deepEqual(clientReceipt.receipt.sharedFile, readClientCredentialFileIdentity(statePath));
  assert.deepEqual(
    clientReceipt.receipt.source,
    readClientCredentialBootstrapSource(shared, statePath),
  );
  const clientDb = getNodeSqliteKysely<ClientCredentialDatabase>(custody.database);
  const daemonReceipt = readDaemonRuntimePinMigrationReceipt(env);
  assert.equal(daemonReceipt?.source_state, statePath);
  assert.equal(daemonReceipt?.phase, "complete");
  const { lastRunAt, lastRunVersion, lastRunCommit, lastRunCommand, lastRunMode, ...wizardState } =
    config.sourceConfig.wizard ?? {};
  const configState = {
    ...config.sourceConfig,
    wizard: Object.keys(wizardState).length ? wizardState : undefined,
  };
  const rootHealth = readConfigHealthStateInDatabase(shared).entries?.[config.path];
  const fingerprint = (stored: ConfigHealthFingerprint | undefined) => {
    if (!stored) {
      return undefined;
    }
    const { observedAt, ...facts } = stored;
    assert.ok(Number.isFinite(Date.parse(observedAt)), "Config observation time must be recorded");
    const { observedAt: _now, ...current } = createConfigHealthFingerprint({
      raw,
      parsed: config.parsed,
      resolved: config.resolved,
      stat: statSync(config.path),
    });
    assert.deepEqual(facts, current, "Config health must describe the current root file");
    const normalized = createConfigHealthFingerprint({
      raw: JSON.stringify(normalizeFixture(configState, root)),
      parsed: config.parsed,
      resolved: config.resolved,
      stat: null,
    });
    return {
      ...facts,
      hash: normalized.hash,
      bytes: normalized.bytes,
      mtimeMs: "<validated-file-time>",
      ctimeMs: "<validated-file-time>",
      dev: "<validated-file-identity>",
      ino: "<validated-file-identity>",
    };
  };
  return {
    diagnostics: {
      sharedCleanClose,
      agentCleanClose,
      wizardRun: { lastRunAt, lastRunVersion, lastRunCommit, lastRunCommand, lastRunMode },
    },
    state: normalizeFixture(
      {
        config: configState,
        workspaces,
        legacyMainSessions: {
          armed: legacySessions.armed,
          complete: legacySessions.complete,
          ledgerComplete: legacySessions.ledgerComplete,
          legacyAgentId: legacySessions.legacyAgentId,
          mainKey: legacySessions.mainKey,
          ownerAgentId: legacySessions.ownerAgentId,
        },
        shared: {
          configHealth: rootHealth && {
            lastKnownGood: fingerprint(rootHealth.lastKnownGood),
            lastPromotedGood: fingerprint(rootHealth.lastPromotedGood),
            lastObservedSuspiciousSignature: rootHealth.lastObservedSuspiciousSignature,
          },
          version: readSqliteUserVersion(shared),
          contentVersion: readStateSchemaContentVersion(shared),
          startupReady,
          deletionJournal,
          deletedAgents,
          ownership: inspectOpenClawStateOwnershipFromDatabase(shared, statePath),
          schema: executeSqliteQuerySync(
            shared,
            sharedDb
              .selectFrom("schema_meta")
              .select(["meta_key", "role", "schema_version", "agent_id", "app_version"])
              .orderBy("meta_key"),
          ).rows,
          machineState: machines,
          pluginState: executeSqliteQuerySync(
            shared,
            sharedDb
              .selectFrom("plugin_state_entries")
              .select(["plugin_id", "namespace", "entry_key", "value_json", "expires_at"])
              .orderBy("plugin_id")
              .orderBy("namespace")
              .orderBy("entry_key"),
          ).rows.map((entry) => ({
            plugin_id: entry.plugin_id,
            namespace: entry.namespace,
            entry_key: entry.entry_key,
            expires_at: entry.expires_at,
            value: JSON.parse(entry.value_json) as unknown,
          })),
          approvals: executeSqliteQuerySync(
            shared,
            sharedDb.selectFrom("plugin_binding_approvals").selectAll().orderBy("plugin_id"),
          ).rows,
          authOwner: inspectSharedAuthStoreOwnership(env),
          auth: auth("shared-state", statePath),
          bundledDiscovery: readBundledDiscoveryMode(
            { env, path: statePath },
            { artifactPreservingReadOnly: true },
          ),
        },
        agents,
        registered: registered
          .map(({ lastSeenAt: _time, sizeBytes: _size, ...entry }) => entry)
          .toSorted((left, right) => left.path.localeCompare(right.path)),
        client: {
          version: readSqliteUserVersion(custody.database),
          receipt: {
            ...clientReceipt.receipt,
            source: {
              ...clientReceipt.receipt.source,
              identity: "<validated-shared-identity>",
              generation: "<validated-shared-generation>",
            },
            sharedFile: "<validated-shared-file>",
          },
          identities: executeSqliteQuerySync(
            custody.database,
            clientDb.selectFrom("device_identities").selectAll().orderBy("identity_key"),
          ).rows,
          tokens: executeSqliteQuerySync(
            custody.database,
            clientDb
              .selectFrom("device_auth_tokens")
              .selectAll()
              .orderBy("device_id")
              .orderBy("role"),
          ).rows,
          origins: executeSqliteQuerySync(
            custody.database,
            clientDb
              .selectFrom("gateway_origin_device_tokens")
              .selectAll()
              .orderBy("gateway_scope")
              .orderBy("device_id")
              .orderBy("role"),
          ).rows,
          sockets: executeSqliteQuerySync(
            custody.database,
            clientDb.selectFrom("native_exec_socket_credentials").selectAll().orderBy("socket_key"),
          ).rows,
        },
        daemon: {
          receipt: daemonReceipt,
          pins: withDaemonRuntimePinStore(env, false, (database) =>
            executeSqliteQuerySync(
              database,
              getNodeSqliteKysely<DaemonRuntimePinDatabase>(database)
                .selectFrom("daemon_runtime_pins")
                .select(["state_key", "value_json"])
                .orderBy("state_key"),
            ).rows.map(({ state_key, value_json }) => ({
              key: state_key,
              value: JSON.parse(value_json) as unknown,
            })),
          ),
        },
      },
      root,
    ),
  };
}
