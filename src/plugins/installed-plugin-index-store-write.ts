/** Writes, restores, and refreshes the installed plugin index in the state database. */
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { serializePluginInstallRecordMap } from "../config/plugin-install-record-map.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { pluginCohortPublicationContext } from "../infra/update-plugin-cohort-context.js";
import type { PluginCohortRecovery } from "../infra/update-plugin-cohort-schema.js";
import { recordPluginCohortIndexPublicationInDatabase } from "../infra/update-run-recovery-store.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { isGatewayPluginMetadataSnapshotActive } from "./current-plugin-metadata-state.js";
import type { PluginCandidate } from "./discovery.types.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";
import { inspectPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-state.js";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "./installed-plugin-index-row.js";
import { preservePluginSourceAdmissions } from "./installed-plugin-index-source-admissions.js";
import {
  applyPluginSourceSnapshotChanges,
  diffPluginSourceSnapshotStates,
  forgetCollectedPluginSourceSnapshots,
  preservePluginSourceSnapshots,
  reconcileRetiredPluginSourceSnapshots,
  restorePluginSourceSnapshotStates,
} from "./installed-plugin-index-source-snapshots.js";
import {
  legacyInstalledPluginIndexUnsupportedMessage,
  resolveInstalledPluginIndexStateDatabaseOptions,
} from "./installed-plugin-index-store-path.js";
import {
  resolveRefreshedPersistedInstalledPluginIndex,
  type PreparedPluginCandidate,
  type PreparedInstalledPluginIndexRefresh,
} from "./installed-plugin-index-store-refresh.js";
import {
  parseInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { forgetPublishedPluginSnapshotCandidates } from "./installed-plugin-snapshot-candidates.kernel.js";
import type { PluginSnapshotCandidateOperation } from "./installed-plugin-snapshot-candidates.types.js";
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "./plugin-lifecycle-lease-identity.js";
import {
  withPluginLifecycleLeaseAsync,
  type PluginMetadataLeaseContext,
} from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";
import type { PluginSourceSnapshotChanges } from "./plugin-source-snapshot.types.js";

type SourceSnapshotMutations = Omit<PluginSourceSnapshotChanges, "sourceSnapshotRestorations">;

export type InstalledPluginIndexWriteLease = {
  assertOwnedInTransaction(database: EngineConnection, stage?: "transaction" | "commit"): void;
};

export type InstalledPluginIndexWriteReceipt = {
  previous: InstalledPluginIndex | null;
  revision: number;
  /** Exact transaction-owned facts, not permission to restore or proof of current state. */
  mutation: {
    databasePath: string;
    before: InstalledPluginIndexRow | null;
    after: InstalledPluginIndexRow;
  };
};

export type InstalledPluginIndexWriteOperations = PluginSnapshotCandidateOperation & {
  "plugins.metadata.index.sourceSnapshots": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      changes: SourceSnapshotMutations;
    };
    output: (InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex }) | null;
  };
  "plugins.metadata.index.write": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      index: InstalledPluginIndex;
      pluginCohort?: PluginCohortIndexBinding;
    };
    output: InstalledPluginIndexWriteReceipt;
  };
  "plugins.metadata.index.restore": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      index: InstalledPluginIndex | null;
      expectedRevision: number;
      pluginCohort?: PluginCohortIndexBinding;
    };
    output: boolean;
  };
  "plugins.metadata.index.refresh": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      prepared: PreparedInstalledPluginIndexRefresh;
      pluginCohort?: PluginCohortIndexBinding;
    };
    output: InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex };
  };
};

type PluginCohortIndexBinding = Pick<
  PluginCohortRecovery,
  "runId" | "transactionId" | "installKey"
>;

type InstalledPluginIndexDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
type InstalledPluginIndexRow = Pick<
  InstalledPluginIndexDatabase["config_machine_state"],
  "state_key" | "value_json" | "updated_at_ms"
>;
type PersistedInstalledPluginIndexValue = { revision: number; index: unknown };

export function readInstalledPluginIndexRow(
  database: EngineConnection,
): InstalledPluginIndexRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<InstalledPluginIndexDatabase>(database)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json", "updated_at_ms"])
      .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
  );
}

export function parseInstalledPluginIndexRow(
  row: InstalledPluginIndexRow | undefined,
): PersistedInstalledPluginIndexValue | undefined {
  if (!row) {
    return undefined;
  }
  const value = safeParseJson(row.value_json);
  if (
    !value ||
    typeof value !== "object" ||
    // SAFETY: shape-checked field probe; the full value is validated below.
    typeof (value as PersistedInstalledPluginIndexValue).revision !== "number"
  ) {
    return undefined;
  }
  // SAFETY: revision checked above; index stays unknown until parseInstalledPluginIndex.
  return value as PersistedInstalledPluginIndexValue;
}

function assertWritableInstalledPluginIndexStoreOptions(
  options: InstalledPluginIndexStoreOptions,
): void {
  if (options.filePath?.endsWith(".json")) {
    throw new Error(legacyInstalledPluginIndexUnsupportedMessage(options.filePath));
  }
}

function preparePersistedInstalledPluginIndex(index: InstalledPluginIndex): InstalledPluginIndex {
  // Index construction and persisted-data ingress already normalize install records.
  return {
    ...index,
    warning: INSTALLED_PLUGIN_INDEX_WARNING,
  };
}

function resolveNextInstalledPluginIndexRevision(current: number | null): number {
  // Revisions fence rollback across processes, so same-millisecond writes must
  // still receive distinct values.
  return Math.max(Date.now(), (current ?? 0) + 1);
}

function writePersistedInstalledPluginIndexRow(
  database: EngineConnection,
  index: InstalledPluginIndex,
  revision: number,
): InstalledPluginIndexRow {
  const persistedIndex = {
    version: index.version,
    warning: index.warning ?? INSTALLED_PLUGIN_INDEX_WARNING,
    hostContractVersion: index.hostContractVersion,
    compatRegistryVersion: index.compatRegistryVersion,
    migrationVersion: index.migrationVersion,
    policyHash: index.policyHash,
    generatedAtMs: index.generatedAtMs,
    ...(index.workspaceDir !== undefined ? { workspaceDir: index.workspaceDir } : {}),
    ...(index.refreshReason ? { refreshReason: index.refreshReason } : {}),
    // SAFETY: canonical serializer output re-parsed for byte-order-stable embedding.
    installRecords: JSON.parse(serializePluginInstallRecordMap(index.installRecords)) as unknown,
    ...(index.retiredSourceSnapshots?.length
      ? { retiredSourceSnapshots: index.retiredSourceSnapshots }
      : {}),
    plugins: index.plugins.map((plugin) => {
      const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
      return {
        ...plugin,
        ...(installOwner ? { installOwner } : {}),
        ...(isInstalledPluginIndexInstallOwnerAmbiguous(plugin)
          ? { installOwnerAmbiguous: true }
          : {}),
      };
    }),
    // Keep v1 readable by v2026.9.6 until a format migration; the code retains info severity.
    diagnostics: index.diagnostics.map((diagnostic) =>
      diagnostic.level === "info" && diagnostic.code === "explicit-config-plugin-selection"
        ? { ...diagnostic, level: "warn" }
        : diagnostic,
    ),
  };
  const valueJson = JSON.stringify({
    revision,
    index: persistedIndex,
  } satisfies PersistedInstalledPluginIndexValue);
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<InstalledPluginIndexDatabase>(database)
      .insertInto("config_machine_state")
      .values({
        state_key: INSTALLED_PLUGIN_INDEX_STATE_KEY,
        value_json: valueJson,
        updated_at_ms: revision,
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at_ms: eb.ref("excluded.updated_at_ms"),
        })),
      ),
  );
  // sqlite-allow-raw: Serialization precedes native prepare; the caller owns rollback.
  database.prepare(compiled.sql).run(...bind());
  forgetPublishedPluginSnapshotCandidates(
    database,
    index.plugins.map((plugin) => plugin.sourceSnapshot),
  );
  return {
    state_key: INSTALLED_PLUGIN_INDEX_STATE_KEY,
    value_json: valueJson,
    updated_at_ms: revision,
  };
}

export function writePersistedInstalledPluginIndexToSqlite(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions & { database?: OpenClawStateDatabase },
  lease: InstalledPluginIndexWriteLease,
  preserveAdmissions = false,
  pluginCohort?: PluginCohortIndexBinding,
  sourceSnapshotChanges: PluginSourceSnapshotChanges = {},
  retainSourceSnapshotWarnings = false,
): InstalledPluginIndexWriteReceipt {
  assertWritableInstalledPluginIndexStoreOptions(options);
  const persisted = preparePersistedInstalledPluginIndex(index);
  return runOpenClawStateWriteTransaction(
    ({ db, path: databasePath }) => {
      const before = readInstalledPluginIndexRow(db);
      const previousRow = parseInstalledPluginIndexRow(before);
      const previous = previousRow ? parseInstalledPluginIndex(previousRow.index) : null;
      let previousInstallRecords = previous?.installRecords;
      // Raw unversioned rows need record preimages only during cohort recovery.
      if (!previous && before && (previousRow || pluginCohort)) {
        const state = inspectPersistedInstalledPluginIndexInstallRecords({
          state: { status: "present", value: safeParseJson(before.value_json) },
        });
        if (state.status === "invalid") {
          throw new Error(
            "Persisted plugin install records are invalid. Repair the state before writing plugin installation metadata.",
          );
        }
        previousInstallRecords = state.status === "valid" ? state.records : {};
      }
      lease.assertOwnedInTransaction(db);
      if (preserveAdmissions) {
        preservePluginSourceAdmissions(previous, persisted);
        preservePluginSourceSnapshots(previous, persisted);
      }
      const revision = resolveNextInstalledPluginIndexRevision(
        previousRow ? previousRow.revision : null,
      );
      applyPluginSourceSnapshotChanges(
        persisted,
        revision,
        sourceSnapshotChanges,
        retainSourceSnapshotWarnings,
      );
      if (sourceSnapshotChanges.sourceSnapshotRestorations) {
        restorePluginSourceSnapshotStates(
          previous,
          persisted,
          sourceSnapshotChanges.sourceSnapshotRestorations,
        );
      }
      reconcileRetiredPluginSourceSnapshots(previous, persisted);
      forgetCollectedPluginSourceSnapshots(
        persisted,
        sourceSnapshotChanges.collectedSourceSnapshots ?? [],
      );
      if (pluginCohort) {
        recordPluginCohortIndexPublicationInDatabase(
          db,
          pluginCohort,
          previousInstallRecords ?? {},
          persisted.installRecords,
          diffPluginSourceSnapshotStates(previous, persisted),
        );
      }
      // Refresh returns this projection; publish its replaced diagnostic array with the row.
      index.diagnostics = persisted.diagnostics;
      index.retiredSourceSnapshots = persisted.retiredSourceSnapshots;
      const after = writePersistedInstalledPluginIndexRow(db, persisted, revision);
      lease.assertOwnedInTransaction(db, "commit");
      return {
        previous,
        revision,
        mutation: { databasePath, before: before ?? null, after },
      };
    },
    { ...resolveInstalledPluginIndexStateDatabaseOptions(options), database: options.database },
  );
}

/** Publish or retire prepared source facts without rediscovering the original plugin tree. */
export async function updateInstalledPluginSourceSnapshots(
  params: InstalledPluginIndexStoreOptions &
    SourceSnapshotMutations & {
      lease?: PluginMetadataLeaseContext;
      assertCurrent?: () => void;
    },
): Promise<(InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex }) | null> {
  const changes: SourceSnapshotMutations = {
    sourceSnapshots: params.sourceSnapshots,
    sourceSnapshotRemovals: params.sourceSnapshotRemovals,
    sourceSnapshotRetirements: params.sourceSnapshotRetirements,
    collectedSourceSnapshots: params.collectedSourceSnapshots,
  };
  const update = (lease: PluginMetadataLeaseContext) =>
    runInstalledPluginIndexWrite(
      params,
      lease,
      (scope, identity) =>
        scope.execute({
          type: "plugins.metadata.index.sourceSnapshots",
          input: { identity, changes },
        }),
      params.assertCurrent,
    );
  return params.lease
    ? update(params.lease)
    : withPluginLifecycleLeaseAsync(
        resolveInstalledPluginIndexStateDatabaseOptions(params),
        update,
      );
}

/** Merge prepared facts against the worker's current row, never the caller's old inventory. */
export function publishPluginSourceAdmissionInDatabase(
  database: EngineConnection,
  publication: PluginSourceAdmissionPublication,
): boolean {
  // Only the lifecycle owner releases or reclaims its holder; receipts cannot fence its rollback.
  const lifecycleLease = readOpenClawStateLease(database, PLUGIN_LIFECYCLE_LEASE_IDENTITY);
  if (lifecycleLease) {
    return false;
  }
  const stored = parseInstalledPluginIndexRow(readInstalledPluginIndexRow(database));
  const index = stored ? parseInstalledPluginIndex(stored.index) : null;
  const plugin = index?.plugins.find((record) => record.pluginId === publication.pluginId);
  if (
    !stored ||
    !index ||
    !plugin ||
    plugin.rootDir !== publication.rootDir ||
    plugin.installRecordHash !== publication.installRecordHash
  ) {
    return false;
  }
  if (isDeepStrictEqual(plugin.sourceAdmissions?.[publication.key], publication.receipt)) {
    return true;
  }
  plugin.sourceAdmissions = {
    ...plugin.sourceAdmissions,
    [publication.key]: publication.receipt,
  };
  writePersistedInstalledPluginIndexRow(
    database,
    index,
    resolveNextInstalledPluginIndexRevision(stored.revision),
  );
  return true;
}

function clearPersistedInstalledPluginIndexCaches(): void {
  // Install transactions change the next boot's inventory, never the running Gateway's graph.
  if (!isGatewayPluginMetadataSnapshotActive()) {
    clearPluginMetadataLifecycleCaches();
  }
  clearLoadInstalledPluginIndexInstallRecordsCache();
}

export async function writePersistedInstalledPluginIndex(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): Promise<string> {
  assertWritableInstalledPluginIndexStoreOptions(options);
  const captured = {
    ...options,
    env: cloneEnvWithPlatformSemantics(
      resolveInstalledPluginIndexStateDatabaseOptions(options).env ?? options.env ?? process.env,
    ),
    filePath: resolveInstalledPluginIndexStorePath(options),
  };
  return await withPluginLifecycleLeaseAsync(
    resolveInstalledPluginIndexStateDatabaseOptions(captured),
    async (lease) => {
      await runInstalledPluginIndexWrite(captured, lease, (scope, identity, pluginCohort) =>
        scope.execute({
          type: "plugins.metadata.index.write",
          input: { identity, index, ...(pluginCohort ? { pluginCohort } : {}) },
        }),
      );
      return captured.filePath;
    },
  );
}

/** Restore a snapshot only while the caller's tentative write is still current. */
export async function restorePersistedInstalledPluginIndexIfCurrent(
  index: InstalledPluginIndex | null,
  expectedRevision: number,
  options: InstalledPluginIndexStoreOptions & {
    lease: PluginMetadataLeaseContext;
  },
): Promise<boolean> {
  const { lease, ...storeOptions } = options;
  assertWritableInstalledPluginIndexStoreOptions(storeOptions);
  if (!existsSync(resolveInstalledPluginIndexStorePath(storeOptions))) {
    return false;
  }
  return runInstalledPluginIndexWrite(storeOptions, lease, (scope, identity, pluginCohort) =>
    scope.execute({
      type: "plugins.metadata.index.restore",
      input: { identity, index, expectedRevision, ...(pluginCohort ? { pluginCohort } : {}) },
    }),
  );
}

export function restorePersistedInstalledPluginIndexInDatabase(
  index: InstalledPluginIndex | null,
  expectedRevision: number,
  database: OpenClawStateDatabase,
  lease: InstalledPluginIndexWriteLease,
  pluginCohort?: PluginCohortIndexBinding,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      lease.assertOwnedInTransaction(db);
      const before = readInstalledPluginIndexRow(db) ?? null;
      const currentRow = parseInstalledPluginIndexRow(before ?? undefined);
      const currentRevision = currentRow ? currentRow.revision : null;
      if (currentRevision !== expectedRevision) {
        lease.assertOwnedInTransaction(db, "commit");
        return false;
      }
      if (pluginCohort) {
        const current = inspectPersistedInstalledPluginIndexInstallRecords({
          state: currentRow
            ? { status: "present", value: { index: currentRow.index } }
            : { status: "missing" },
        });
        if (current.status === "invalid") {
          throw new Error("Plugin index compensation cannot journal invalid current records.");
        }
        recordPluginCohortIndexPublicationInDatabase(
          db,
          pluginCohort,
          current.status === "valid" ? current.records : {},
          index?.installRecords ?? {},
        );
      }
      const current = currentRow ? parseInstalledPluginIndex(currentRow.index) : null;
      const restored = index
        ? preparePersistedInstalledPluginIndex(index)
        : current
          ? { ...current, installRecords: {}, plugins: [], diagnostics: [] }
          : null;
      if (restored) {
        reconcileRetiredPluginSourceSnapshots(current, restored);
      }
      if (restored && (index || restored.retiredSourceSnapshots?.length)) {
        writePersistedInstalledPluginIndexRow(
          db,
          restored,
          resolveNextInstalledPluginIndexRevision(currentRevision),
        );
      } else {
        const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
          getNodeSqliteKysely<InstalledPluginIndexDatabase>(db)
            .deleteFrom("config_machine_state")
            .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
        );
        // sqlite-allow-raw: Compiled SQL preserves native deletion in the leased transaction.
        db.prepare(compiled.sql).run(...bind());
      }
      lease.assertOwnedInTransaction(db, "commit");
      return true;
    },
    { database },
  );
}

async function runInstalledPluginIndexWrite<T>(
  options: InstalledPluginIndexStoreOptions,
  lease: PluginMetadataLeaseContext,
  operation: (
    scope: Pick<SqliteWorkerStore<InstalledPluginIndexWriteOperations>, "execute">,
    identity: OpenClawStateLeaseIdentity,
    pluginCohort?: PluginCohortIndexBinding,
  ) => Promise<T>,
  assertCurrent?: () => void,
  onAcknowledged?: (result: T) => void,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext(
    resolveInstalledPluginIndexStateDatabaseOptions(options),
  );
  const scoped = pluginCohortPublicationContext.getStore();
  const cohort =
    scoped && resolveOpenClawStateSqlitePath(scoped.env) === context.admission.databasePath
      ? scoped
      : undefined;
  const binding = cohort
    ? { runId: cohort.runId, transactionId: cohort.transactionId, installKey: cohort.installKey }
    : undefined;
  const assertAuthority = () => {
    lease.assertCurrent();
    assertCurrent?.();
    cohort?.assertCurrent();
  };
  assertAuthority();
  const { runWithOpenClawStateLeaseWorker } =
    await import("../state/openclaw-state-lease-worker-operation.js");
  const result = await runWithOpenClawStateLeaseWorker(
    lease.stateLease,
    context,
    (scope, identity) => operation(scope, identity, binding),
    {
      assertCurrent: () => lease.assertCurrent(),
      beforeTransaction: assertAuthority,
      beforeCommit: assertAuthority,
    },
  );
  // Preserve the committed outcome for compensation before refusing a late caller.
  try {
    onAcknowledged?.(result);
  } finally {
    // A refused late caller or mismatched rollback still leaves an acknowledged database result.
    clearPersistedInstalledPluginIndexCaches();
  }
  assertAuthority();
  return result;
}

export async function refreshPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease?: PluginMetadataLeaseContext;
    },
): Promise<InstalledPluginIndex> {
  return (await refreshPersistedInstalledPluginIndexWithReceipt(params)).index;
}

export async function refreshPersistedInstalledPluginIndexWithReceipt(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease?: PluginMetadataLeaseContext;
      assertCurrent?: () => void;
      onAcknowledged?: (receipt: InstalledPluginIndexWriteReceipt) => void;
    },
): Promise<InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex }> {
  const { lease: callerLease, now, assertCurrent, onAcknowledged } = params;
  assertWritableInstalledPluginIndexStoreOptions(params);
  const databaseOptions = resolveInstalledPluginIndexStateDatabaseOptions(params);
  const env = cloneEnvWithPlatformSemantics(databaseOptions.env ?? params.env ?? process.env);
  const options = { ...databaseOptions, env };
  const storeOptions = { env, filePath: resolveInstalledPluginIndexStorePath(params) };
  // Doctor also passes host-only services; symbol-backed candidate ownership needs explicit transport.
  const prepareCandidates = (candidates: PluginCandidate[]): PreparedPluginCandidate[] =>
    candidates.map((candidate) => ({
      candidate,
      installOwner: resolvePluginCandidateInstallOwner(candidate),
      ambiguous: isPluginCandidateInstallOwnerAmbiguous(candidate),
    }));
  const prepared: PreparedInstalledPluginIndexRefresh = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: params.stateDir,
    filePath: params.filePath,
    pluginIndexFilePath: params.pluginIndexFilePath,
    installRecords: params.installRecords,
    candidates: params.candidates && prepareCandidates(params.candidates),
    diagnostics: params.diagnostics,
    discovery: params.discovery && {
      candidates: prepareCandidates(params.discovery.candidates),
      diagnostics: params.discovery.diagnostics,
    },
    reason: params.reason,
    policyPluginIds: params.policyPluginIds,
    sourceSnapshots: params.sourceSnapshots,
    sourceSnapshotRemovals: params.sourceSnapshotRemovals,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
    sourceSnapshotRestorations: params.sourceSnapshotRestorations,
    // Windows snapshots are proxies; the worker restores their semantics from these entries.
    env: { ...env },
    installRoots: resolveActivePluginInstallRoots(env),
    ...(now ? { nowMs: now().getTime() } : {}),
  };
  const refresh = async (lease: PluginMetadataLeaseContext) => {
    const receipt = await runInstalledPluginIndexWrite(
      storeOptions,
      lease,
      (scope, identity, pluginCohort) =>
        scope.execute({
          type: "plugins.metadata.index.refresh",
          input: { identity, prepared, ...(pluginCohort ? { pluginCohort } : {}) },
        }),
      assertCurrent,
      onAcknowledged,
    );
    return receipt;
  };
  return callerLease ? refresh(callerLease) : withPluginLifecycleLeaseAsync(options, refresh);
}

export function refreshPersistedInstalledPluginIndexWithLeaseSync(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease: InstalledPluginIndexWriteLease;
      database?: OpenClawStateDatabase;
      pluginCohort?: PluginCohortIndexBinding;
    },
): InstalledPluginIndexWriteReceipt & { index: InstalledPluginIndex } {
  const { lease, ...storeParams } = params;
  const index = resolveRefreshedPersistedInstalledPluginIndex(storeParams);
  const receipt = writePersistedInstalledPluginIndexToSqlite(
    index,
    storeParams,
    lease,
    true,
    params.pluginCohort,
    params,
  );
  clearPersistedInstalledPluginIndexCaches();
  return { ...receipt, index };
}
