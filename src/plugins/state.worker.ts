import { ZodError } from "zod";
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
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "./conversation-binding-state.kernel.js";
import type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";
import { publishPluginSourceAdmissionInDatabase } from "./installed-plugin-index-store-write.js";
import {
  readHostedCatalogSnapshotInDatabase,
  writeHostedCatalogSnapshotInDatabase,
} from "./official-external-plugin-catalog-snapshot-store.kernel.js";
import { HostedCatalogSignedFeedMonotonicityError } from "./official-external-plugin-catalog-source.js";
import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.types.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

export const pluginRuntimeOperations = {
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
  "plugins.deferredMigrations.read": (
    input: { artifactPreservingReadOnly: boolean },
    { stateOptions },
  ) =>
    readDeferredPluginMigrations({
      ...stateOptions(),
      artifactPreservingReadOnly: input.artifactPreservingReadOnly,
    }),
  "plugins.deferredMigrations.completions.read": (_input: undefined, { stateOptions }) =>
    readDeferredPluginMigrationCompletions(stateOptions()),
} satisfies WorkerOperationHandlers;
