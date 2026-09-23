import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { ensureWorkerEnvironmentNodeEnrollmentSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentRecord,
  WorkerEnvironmentTeardownTerminalState,
} from "./environment-record.js";
import {
  createPreparedEnvironmentStoreOps,
  workerEnvironmentPreparationColumns,
} from "./prepared-environment-store.js";
import { createWorkerEnvironmentSessionAttachmentStore } from "./session-attachment-store.js";
import type { WorkerEnvironmentAttachmentRecord } from "./session-attachment.js";
import type { WorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentKernelOptions } from "./store-kernel-options.js";
import {
  credentialInsert,
  revokeCredential,
  updateWorkerEnvironmentRecord,
  upsertCredential,
} from "./store-mutations.js";
import {
  findWorkerEnvironment,
  findCredential,
  getRequiredWorkerEnvironment,
  json,
  queryWorkerEnvironmentStore,
} from "./store-row-codec.js";
import { ensureWorkerEnvironmentStoreSchema } from "./store-schema.js";
import { createWorkerEnvironmentTransitionOps } from "./store-transitions.js";
import {
  normalizeCredentialHash,
  normalizeExpiry,
  normalizeSessionId,
  requireWorkerEnvironmentString,
  TERMINAL_STATES,
} from "./store-validation.js";
import type { WorkerEnvironmentMutationMethods } from "./store-worker-contract.js";
import type { CredentialInput, CredentialRevocationInput } from "./store-write-types.js";

export function createWorkerEnvironmentStoreKernel(options: WorkerEnvironmentKernelOptions) {
  const database = options.database;
  ensureWorkerEnvironmentStoreSchema(database);
  const now = options.now ?? Date.now;
  const read = () => database.db;
  const write = options.write;
  const writeCredential = (
    input: CredentialInput & {
      environmentId: string;
      expectedOwnerEpoch: number;
      assertCurrent?: () => void;
    },
  ): WorkerCredentialRecord => {
    const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
    return write((db) => {
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (current.ownerEpoch !== input.expectedOwnerEpoch) {
        throw new Error(`Worker environment ${environmentId} owner epoch changed`);
      }
      if (current.state !== "ready" && current.state !== "idle" && current.state !== "attached") {
        throw new Error(`Cannot mint worker credential in state ${current.state}`);
      }
      if (current.destroyRequestedAtMs !== null) {
        throw new Error("Cannot mint worker credential after destroy is requested");
      }
      if (!current.bootstrapReceipt) {
        throw new Error("Worker environment has no admitted bootstrap identity");
      }
      const updatedAtMs = now();
      const ownerEpoch = Math.max(1, current.ownerEpoch);
      if (ownerEpoch !== current.ownerEpoch) {
        updateWorkerEnvironmentRecord(db, environmentId, current.state, {
          owner_epoch: ownerEpoch,
          updated_at_ms: updatedAtMs,
        });
      }
      upsertCredential(
        db,
        credentialInsert({
          input,
          environmentId,
          bundleHash: current.bootstrapReceipt.bundleHash,
          attachedSessionIds: current.attachedSessionIds,
          ownerEpoch,
          nowMs: updatedAtMs,
        }),
      );
      const credential = findCredential(db, environmentId);
      if (!credential) {
        throw new Error("Worker credential persistence failed");
      }
      return credential;
    });
  };
  const createIntent = (
    db: DatabaseSync,
    input: WorkerEnvironmentIntentInput,
  ): WorkerEnvironmentRecord => {
    const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
    const createdAtMs = now();
    executeSqliteQuerySync(
      db,
      queryWorkerEnvironmentStore(db)
        .insertInto("worker_environments")
        .values({
          environment_id: environmentId,
          provider_id: requireWorkerEnvironmentString(input.providerId, "provider id"),
          profile_id: requireWorkerEnvironmentString(input.profileId, "profile id"),
          profile_snapshot_json: json(input.profileSnapshot),
          ...workerEnvironmentPreparationColumns(input.preparation),
          last_activated_at_ms: null,
          provision_operation_id: requireWorkerEnvironmentString(
            input.provisionOperationId,
            "provision operation id",
          ),
          lease_id: null,
          node_setup_id: null,
          node_device_id: null,
          shared_host: null,
          ssh_host: null,
          ssh_port: null,
          ssh_user: null,
          ssh_host_key: null,
          ssh_key_ref_json: null,
          desktop_json: null,
          bootstrap_bundle_hash: null,
          bootstrap_openclaw_version: null,
          bootstrap_protocol_features_json: null,
          bootstrap_install_kind: null,
          owner_epoch: 0,
          teardown_terminal_state: null,
          state: "requested",
          created_at_ms: createdAtMs,
          updated_at_ms: createdAtMs,
          state_changed_at_ms: createdAtMs,
          idle_since_at_ms: null,
          destroy_requested_at_ms: null,
          last_error: null,
        }),
    );
    return getRequiredWorkerEnvironment(db, environmentId);
  };
  return {
    ...createPreparedEnvironmentStoreOps({ now, write, createIntent, get: findWorkerEnvironment }),
    ...createWorkerEnvironmentSessionAttachmentStore({
      now,
      read,
      write,
      createIntent,
      getEnvironment: findWorkerEnvironment,
    }),
    ...createWorkerEnvironmentTransitionOps({ now, write }),
    createIntent(input: WorkerEnvironmentIntentInput): WorkerEnvironmentRecord {
      return write((db) => createIntent(db, input));
    },
    ensureNodeEnrollment(environmentIdInput: string): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(environmentIdInput, "id");
      return write((db) => {
        ensureWorkerEnvironmentNodeEnrollmentSchema(db);
        const current = getRequiredWorkerEnvironment(db, environmentId);
        if (TERMINAL_STATES.includes(current.state) || current.destroyRequestedAtMs !== null) {
          throw new Error(`Worker environment ${environmentId} cannot begin node enrollment`);
        }
        const setupId = current.nodeSetupId ?? randomUUID();
        const completion = executeSqliteQueryTakeFirstSync(
          db,
          queryWorkerEnvironmentStore(db)
            .selectFrom("device_pair_setup_completions")
            .select("device_id")
            .where("setup_id", "=", setupId),
        );
        const completedDeviceId = completion?.device_id ?? null;
        if (
          current.nodeDeviceId !== null &&
          completedDeviceId !== null &&
          current.nodeDeviceId !== completedDeviceId
        ) {
          throw new Error(`Worker environment ${environmentId} node enrollment identity changed`);
        }
        const nodeDeviceId = current.nodeDeviceId ?? completedDeviceId;
        if (current.nodeSetupId === setupId && current.nodeDeviceId === nodeDeviceId) {
          return current;
        }
        return updateWorkerEnvironmentRecord(db, environmentId, current.state, {
          node_setup_id: setupId,
          node_device_id: nodeDeviceId,
          updated_at_ms: now(),
        });
      });
    },
    revokeEnvironmentCredential(input: CredentialRevocationInput): void {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      return write((db) => {
        if (
          input.expectedOwnerEpoch !== undefined &&
          getRequiredWorkerEnvironment(db, environmentId).ownerEpoch !== input.expectedOwnerEpoch
        ) {
          throw new Error(`Worker environment ${environmentId} owner epoch changed`);
        }
        revokeCredential(db, environmentId);
      });
    },
    reconcileSharedHost(input: {
      environmentId: string;
      state: WorkerEnvironmentState;
      leaseId: string;
      sharedHost: boolean;
    }): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const leaseId = requireWorkerEnvironmentString(input.leaseId, "lease id");
      return write((db) => {
        const current = getRequiredWorkerEnvironment(db, environmentId);
        if (current.state !== input.state || current.leaseId !== leaseId) {
          throw new Error(`Worker environment ${environmentId} lease changed during inspection`);
        }
        if (current.sharedHost === input.sharedHost) {
          return current;
        }
        // Provider inspection owns facts that may predate their durable column. Persist an
        // explicit value before tunnel startup so upgraded leases cannot keep stale isolation.
        return updateWorkerEnvironmentRecord(db, environmentId, current.state, {
          shared_host: input.sharedHost ? 1 : 0,
          updated_at_ms: now(),
        });
      });
    },
    adoptProvisionCleanupFailure(input: {
      environmentId: string;
      leaseId: string;
      lastError: string;
    }): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const leaseId = requireWorkerEnvironmentString(input.leaseId, "lease id");
      const lastError = requireWorkerEnvironmentString(input.lastError, "last error");
      return write((db) => {
        const current = getRequiredWorkerEnvironment(db, environmentId);
        if (current.state !== "provisioning" || current.leaseId !== null) {
          throw new Error(`Worker environment ${environmentId} cannot adopt provision cleanup`);
        }
        const updatedAtMs = now();
        // Lease identity and teardown ownership must become durable together. A crash between
        // separate writes would make startup replay an operation whose fixed id may be terminal.
        return updateWorkerEnvironmentRecord(db, environmentId, current.state, {
          lease_id: leaseId,
          state: "destroying",
          updated_at_ms: updatedAtMs,
          state_changed_at_ms: updatedAtMs,
          destroy_requested_at_ms: current.destroyRequestedAtMs ?? updatedAtMs,
          teardown_terminal_state: current.teardownTerminalState ?? "failed",
          last_error: lastError,
        });
      });
    },
    requestDestroy(input: {
      environmentId: string;
      state: WorkerEnvironmentState;
      terminalState?: WorkerEnvironmentTeardownTerminalState;
      assertCurrent?: () => void;
      lastError?: string;
    }) {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      return write((db) => {
        const current = getRequiredWorkerEnvironment(db, environmentId);
        if (current.state !== input.state) {
          throw new Error(`Worker environment ${environmentId} changed before destroy request`);
        }
        if (current.destroyRequestedAtMs !== null) {
          return current;
        }
        const requestedAtMs = now();
        const terminalState = input.terminalState ?? "destroyed";
        return updateWorkerEnvironmentRecord(db, environmentId, input.state, {
          updated_at_ms: requestedAtMs,
          destroy_requested_at_ms: requestedAtMs,
          teardown_terminal_state: terminalState,
          ...(input.lastError === undefined
            ? {}
            : { last_error: requireWorkerEnvironmentString(input.lastError, "last error") }),
        });
      });
    },
    renewCredential(
      input: CredentialInput & {
        environmentId: string;
        expectedOwnerEpoch: number;
        assertCurrent?: () => void;
      },
    ): WorkerCredentialRecord {
      return writeCredential(input);
    },
    markCredentialDelivered(input: {
      environmentId: string;
      credentialHash: string;
      ownerEpoch: number;
      sessionId: string | null;
      deliveredAtMs: number;
      assertCurrent?: () => void;
    }): void {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      return write((db) => {
        const environment = getRequiredWorkerEnvironment(db, environmentId);
        const credential = findCredential(db, environmentId);
        if (
          !credential ||
          (environment.state !== "ready" &&
            environment.state !== "idle" &&
            environment.state !== "attached") ||
          environment.destroyRequestedAtMs !== null ||
          credential.credentialHash !== normalizeCredentialHash(input.credentialHash) ||
          credential.ownerEpoch !== input.ownerEpoch ||
          environment.ownerEpoch !== input.ownerEpoch ||
          credential.sessionId !== normalizeSessionId(input.sessionId)
        ) {
          throw new Error(`Worker environment ${environmentId} credential changed`);
        }
        const deliveredAtMs = normalizeExpiry(input.deliveredAtMs);
        if (deliveredAtMs >= credential.expiresAtMs) {
          throw new Error("Expired worker credential cannot be marked delivered");
        }
        const result = executeSqliteQuerySync(
          db,
          queryWorkerEnvironmentStore(db)
            .updateTable("worker_environment_credentials")
            .set({ delivered_at_ms: deliveredAtMs })
            .where("environment_id", "=", environmentId)
            .where("credential_hash", "=", credential.credentialHash)
            .where("owner_epoch", "=", credential.ownerEpoch),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker environment ${environmentId} credential changed`);
        }
      });
    },
    recordError(input: {
      environmentId: string;
      state: WorkerEnvironmentState;
      error: string;
      assertCurrent?: () => void;
    }) {
      return write((db) =>
        updateWorkerEnvironmentRecord(
          db,
          requireWorkerEnvironmentString(input.environmentId, "id"),
          input.state,
          {
            updated_at_ms: now(),
            last_error: requireWorkerEnvironmentString(input.error, "last error"),
          },
        ),
      );
    },
  } satisfies Omit<WorkerEnvironmentMutationMethods, "pruneTerminalEnvironments"> & {
    getSessionAttachmentRecord(sessionId: string): WorkerEnvironmentAttachmentRecord | undefined;
  };
}
