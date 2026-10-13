import { ZodError } from "zod";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  DeferredPluginMigrationConflictError,
  readDeferredPluginMigrationCompletions,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrationsInTransaction,
  type DeferredPluginMigrationRecordInput,
} from "../infra/deferred-plugin-migrations.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { publishBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "./conversation-binding-state.kernel.js";
import type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "./installed-plugin-index-record-state.js";
import {
  publishPluginSourceAdmissionInDatabase,
  refreshPersistedInstalledPluginIndexWithLeaseSync,
  restorePersistedInstalledPluginIndexInDatabase,
  writePersistedInstalledPluginIndexToSqlite,
  type InstalledPluginIndexWriteLease,
  type InstalledPluginIndexWriteOperations,
} from "./installed-plugin-index-store-write.js";
import {
  readHostedCatalogSnapshotInDatabase,
  writeHostedCatalogSnapshotInDatabase,
} from "./official-external-plugin-catalog-snapshot-store.kernel.js";
import { HostedCatalogSignedFeedMonotonicityError } from "./official-external-plugin-catalog-source.js";
import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.types.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  readPluginMetadataStateRowsInDatabase,
} from "./plugin-metadata-state-row.kernel.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

function indexWriteLease(identity: OpenClawStateLeaseIdentity): InstalledPluginIndexWriteLease {
  return {
    assertOwnedInTransaction(db, stage = "transaction") {
      assertOpenClawStateLeaseWorkerOwnedInTransaction(db, identity, "write", stage);
    },
  };
}

export const pluginRuntimeOperations = {
  "plugins.metadata.index.write": (
    input: InstalledPluginIndexWriteOperations["plugins.metadata.index.write"]["input"],
    { open },
  ): InstalledPluginIndexWriteOperations["plugins.metadata.index.write"]["output"] =>
    writePersistedInstalledPluginIndexToSqlite(
      input.index,
      { database: open() },
      indexWriteLease(input.identity),
    ),
  "plugins.metadata.index.restore": (
    input: InstalledPluginIndexWriteOperations["plugins.metadata.index.restore"]["input"],
    { open },
  ): InstalledPluginIndexWriteOperations["plugins.metadata.index.restore"]["output"] =>
    restorePersistedInstalledPluginIndexInDatabase(
      input.index,
      input.expectedRevision,
      open(),
      indexWriteLease(input.identity),
    ),
  "plugins.metadata.index.refresh": (
    input: InstalledPluginIndexWriteOperations["plugins.metadata.index.refresh"]["input"],
    { open },
  ): InstalledPluginIndexWriteOperations["plugins.metadata.index.refresh"]["output"] => {
    const { installRoots, nowMs, candidates, discovery, ...prepared } = input.prepared;
    const restoreCandidates = (values: NonNullable<typeof candidates>) =>
      values.map(({ candidate, installOwner, ambiguous }) =>
        recordPluginCandidateInstallOwner(candidate, installOwner, ambiguous),
      );
    return withPluginInstallRoots(installRoots, () =>
      withPluginCache(createPluginCache(), () => {
        const database = open();
        const env = cloneEnvWithPlatformSemantics(prepared.env);
        const includeIndex = prepared.reason === "policy-changed" || !prepared.installRecords;
        const rows = readPluginMetadataStateRowsInDatabase(
          database.db,
          includeIndex
            ? ["plugins.bundledDiscovery", INSTALLED_PLUGIN_INDEX_STATE_KEY]
            : ["plugins.bundledDiscovery"],
        );
        const discoveryMode = rows.find((row) => row.state_key === "plugins.bundledDiscovery");
        publishBundledDiscoveryMode(
          discoveryMode ? JSON.parse(discoveryMode.value_json) : undefined,
          env,
        );
        if (includeIndex) {
          getPersistedInstalledPluginIndexCacheEntry({ env, filePath: database.path }, () =>
            rows.find((row) => row.state_key === INSTALLED_PLUGIN_INDEX_STATE_KEY),
          );
        }
        return refreshPersistedInstalledPluginIndexWithLeaseSync({
          ...prepared,
          env,
          candidates: candidates && restoreCandidates(candidates),
          discovery: discovery && {
            candidates: restoreCandidates(discovery.candidates),
            diagnostics: discovery.diagnostics,
          },
          filePath: database.path,
          database,
          ...(nowMs !== undefined ? { now: () => new Date(nowMs) } : {}),
          lease: indexWriteLease(input.identity),
        });
      }),
    );
  },
  "plugins.conversationBindingApprovals.read": (_input: undefined, { open }) =>
    readPluginBindingApprovalsInDatabase(open().db),
  "plugins.conversationBindingApprovals.upsert": (
    input: PluginBindingApprovalEntry,
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(({ db }) => upsertPluginBindingApprovalInDatabase(db, input), {
      database: open(),
      ...stateOptions(),
    }),
  "plugins.catalogSnapshot.read": (input: { url: string }, { open }) =>
    readHostedCatalogSnapshotInDatabase(open().db, input.url),
  "plugins.catalogSnapshot.write": (
    input: { snapshot: HostedOfficialExternalPluginCatalogSnapshot; now: number },
    { open, stateOptions },
  ) => {
    const options = { database: open(), ...stateOptions() };
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) => writeHostedCatalogSnapshotInDatabase(db, input.snapshot, input.now),
        options,
      );
      return { ok: true as const };
    } catch (error) {
      if (error instanceof HostedCatalogSignedFeedMonotonicityError) {
        return { ok: false as const, message: error.message };
      }
      throw error;
    }
  },
  "plugins.metadata.sourceAdmission.publish": (
    input: PluginSourceAdmissionPublication,
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => publishPluginSourceAdmissionInDatabase(db, input),
      { database: open(), ...stateOptions() },
    ),
  "plugins.deferredMigrations.record": (
    input: Omit<DeferredPluginMigrationRecordInput, "env"> & {
      identity: OpenClawStateLeaseIdentity;
    },
    { open, stateOptions },
  ) => {
    const options = { database: open(), ...stateOptions() };
    try {
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.identity);
          const transitions = recordDeferredPluginMigrationsInTransaction(db, input);
          assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.identity, "write", "commit");
          return { kind: "recorded" as const, transitions };
        },
        options,
        { operationLabel: "state.plugin-migration-deferral" },
      );
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError) {
        return { kind: "conflict" as const, pending: error.pending };
      }
      if (error instanceof ZodError) {
        return { kind: "invalid" as const, issues: error.issues };
      }
      throw error;
    }
  },
  "plugins.deferredMigrations.completions.read": (_input: undefined, { stateOptions }) =>
    readDeferredPluginMigrationCompletions(stateOptions()),
  // Published 2026.10.1 updaters read pending migrations through this worker
  // after replacing their package. Without their retained runtime (observed on
  // Windows), that worker runs this package's code.
  // Current callers use the read worker. Remove when upgrades from 2026.10.1
  // leave the supported update window.
  "plugins.deferredMigrations.read": (
    input: { artifactPreservingReadOnly: boolean },
    { stateOptions },
  ) =>
    readDeferredPluginMigrations({
      ...stateOptions(),
      artifactPreservingReadOnly: input.artifactPreservingReadOnly,
    }),
} satisfies WorkerOperationHandlers;
