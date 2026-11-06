import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  requireWorkerResourceReceipt,
  sameWorkerResourceReceipt,
} from "../../plugins/worker-resource-receipt.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { ensureWorkerEnvironmentNodeEnrollmentSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
import {
  createPreparedEnvironmentStoreOps,
  workerEnvironmentPreparationColumns,
} from "./prepared-environment-store.js";
import { createWorkerEnvironmentSessionAttachmentStore } from "./session-attachment-store.js";
import type { WorkerEnvironmentAttachmentRecord } from "./session-attachment.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";
import {
  credentialInsert,
  revokeCredential,
  updateRow,
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
} from "./store-validation.js";
import type { CredentialRevocationInput } from "./store-write-types.js";
import { executeWorkerEnvironmentWrite } from "./store-write.js";
import type {
  WorkerEnvironmentMutationInput,
  WorkerEnvironmentMutationMethods,
} from "./store.types.js";

export function createWorkerEnvironmentStoreKernel(
  database: OpenClawStateDatabase,
  now: () => number,
) {
  ensureWorkerEnvironmentStoreSchema(database);
  const db = database.db;
  const createIntent = (input: WorkerEnvironmentIntentInput): WorkerEnvironmentRecord => {
    const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
    const current = findWorkerEnvironment(db, environmentId);
    if (current) {
      if (!isDeepStrictEqual(current.retention?.policy ?? null, input.retention ?? null)) {
        throw new Error(`Worker environment ${environmentId} retention policy is immutable`);
      }
      const preparation = current.preparation && {
        purpose: current.preparation.purpose,
        key: current.preparation.key,
        demandAtMs: current.preparation.demandAtMs,
        expiresAtMs: current.preparation.expiresAtMs,
      };
      if (
        current.providerId !== input.providerId ||
        current.profileId !== input.profileId ||
        current.provisionOperationId !== input.provisionOperationId ||
        !isDeepStrictEqual(current.profileSnapshot, input.profileSnapshot) ||
        !isDeepStrictEqual(preparation, input.preparation ?? null)
      ) {
        throw new Error(`Worker environment ${environmentId} intent binding changed`);
      }
      return current;
    }
    const createdAtMs = now();
    executeWorkerEnvironmentWrite(
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
          resource_receipt_json: null,
          retention_json: input.retention
            ? json({
                policy: input.retention,
                runtimeReady: false,
                operation: null,
                observation: null,
              })
            : null,
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
    ...createPreparedEnvironmentStoreOps({ db, now, createIntent, get: findWorkerEnvironment }),
    ...createWorkerEnvironmentSessionAttachmentStore({
      db,
      now,
      createIntent,
      getEnvironment: findWorkerEnvironment,
    }),
    ...createWorkerEnvironmentTransitionOps(db, now),
    createIntent,
    recordResourceReceipt(
      input: WorkerEnvironmentMutationInput<"recordResourceReceipt">,
    ): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const provisionOperationId = requireWorkerEnvironmentString(
        input.provisionOperationId,
        "provision operation id",
      );
      // Persist the versioned identity contract, not unrelated provider response fields.
      const { version, leaseId, identity } = requireWorkerResourceReceipt(input.receipt);
      const receipt = { version, leaseId, identity };
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (current.provisionOperationId !== provisionOperationId) {
        throw new Error(`Worker environment ${environmentId} provision operation changed`);
      }
      if (current.leaseId !== null && current.leaseId !== receipt.leaseId) {
        throw new Error(`Worker environment ${environmentId} resource receipt lease changed`);
      }
      if (current.resourceReceipt !== null) {
        if (!sameWorkerResourceReceipt(current.resourceReceipt, receipt)) {
          throw new Error(`Worker environment ${environmentId} resource receipt is immutable`);
        }
        return current;
      }
      const updatedAtMs = now();
      updateRow(db, environmentId, current.state, {
        resource_receipt_json: json(receipt),
        updated_at_ms: updatedAtMs,
      });
      return { ...current, resourceReceipt: receipt, updatedAtMs };
    },
    beginRetentionOperation(input) {
      const current = getRequiredWorkerEnvironment(db, input.environmentId);
      if (current.ownerEpoch !== input.expectedOwnerEpoch) {
        throw new Error("Worker environment owner epoch changed");
      }
      const retention = current.retention;
      // Initial provisioning can record exact resource custody before enrollment returns a lease.
      if (
        !retention ||
        !current.resourceReceipt ||
        (current.leaseId === null
          ? current.state !== "provisioning"
          : current.resourceReceipt.leaseId !== current.leaseId)
      ) {
        throw new Error("Worker retention requires a policy and exact resource receipt lease");
      }
      if (
        current.destroyRequestedAtMs !== null ||
        isTerminalWorkerEnvironmentState(current.state)
      ) {
        throw new Error("Worker retention cannot begin after destroy is requested");
      }
      if (retention.operation) {
        if (!isDeepStrictEqual(retention.operation, input.operation)) {
          throw new Error("Worker retention operation is already pending");
        }
        return current;
      }
      if (retention.observation?.claimRevision !== input.operation.expectedClaimRevision) {
        throw new Error("Worker retention claim revision changed");
      }
      const next = { ...retention, runtimeReady: false, operation: input.operation };
      const updatedAtMs = now();
      updateRow(db, current.environmentId, current.state, {
        retention_json: json(next),
        updated_at_ms: updatedAtMs,
      });
      return { ...current, retention: next, updatedAtMs };
    },
    recordRetentionObservation(input) {
      const current = getRequiredWorkerEnvironment(db, input.environmentId);
      if (current.ownerEpoch !== input.expectedOwnerEpoch) {
        throw new Error("Worker environment owner epoch changed");
      }
      const retention = current.retention;
      if (!retention) {
        throw new Error("Worker environment has no retention policy");
      }
      const { operation } = retention;
      const { observation } = input;
      const observedOperation = observation.operation;
      // Transport failure, an unrelated completion, or a pending observation cannot settle intent.
      const settled =
        operation &&
        observedOperation?.phase === "observed" &&
        operation.id === observedOperation.id &&
        operation.action === observedOperation.action &&
        operation.expectedClaimRevision === observedOperation.expectedClaimRevision &&
        (observation.state === (operation.action === "pause" ? "suspended" : "running") ||
          (operation.action === "resume" &&
            (observation.state === "suspended" || observation.state === "expired") &&
            observation.computeExpiresAtMs <= now()));
      const next = {
        ...retention,
        observation,
        operation: settled ? null : operation,
        runtimeReady:
          retention.runtimeReady &&
          observation.state === "running" &&
          retention.observation?.computeExpiresAtMs === observation.computeExpiresAtMs,
      };
      const updatedAtMs = now();
      updateRow(db, current.environmentId, current.state, {
        retention_json: json(next),
        updated_at_ms: updatedAtMs,
      });
      return { ...current, retention: next, updatedAtMs };
    },
    setRetentionRuntimeAdmission(
      input: WorkerEnvironmentMutationInput<"setRetentionRuntimeAdmission">,
    ) {
      const current = getRequiredWorkerEnvironment(db, input.environmentId);
      const retained = current.retention;
      if (
        current.ownerEpoch !== input.expectedOwnerEpoch ||
        current.destroyRequestedAtMs !== null ||
        !retained ||
        retained.operation ||
        retained.observation?.state !== "running" ||
        retained.observation.claimRevision !== input.expectedClaimRevision ||
        retained.observation.computeExpiresAtMs <= now()
      ) {
        throw new Error("Retained runtime admission lost its current work window");
      }
      const retention = { ...retained, runtimeReady: input.ready };
      const updatedAtMs = now();
      updateRow(db, current.environmentId, current.state, {
        retention_json: json(retention),
        updated_at_ms: updatedAtMs,
      });
      return { ...current, retention, updatedAtMs };
    },
    ensureNodeEnrollment(environmentIdInput: string): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(environmentIdInput, "id");
      ensureWorkerEnvironmentNodeEnrollmentSchema(db);
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (
        isTerminalWorkerEnvironmentState(current.state) ||
        current.destroyRequestedAtMs !== null
      ) {
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
    },
    revokeEnvironmentCredential(input: CredentialRevocationInput): void {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      if (
        input.expectedOwnerEpoch !== undefined &&
        getRequiredWorkerEnvironment(db, environmentId).ownerEpoch !== input.expectedOwnerEpoch
      ) {
        throw new Error(`Worker environment ${environmentId} owner epoch changed`);
      }
      revokeCredential(db, environmentId);
    },
    reconcileSharedHost(input): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const leaseId = requireWorkerEnvironmentString(input.leaseId, "lease id");
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
    },
    adoptProvisionCleanupFailure(input): WorkerEnvironmentRecord {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
      const leaseId = requireWorkerEnvironmentString(input.leaseId, "lease id");
      const lastError = requireWorkerEnvironmentString(input.lastError, "last error");
      const current = getRequiredWorkerEnvironment(db, environmentId);
      if (current.state !== "provisioning" || current.leaseId !== null) {
        throw new Error(`Worker environment ${environmentId} cannot adopt provision cleanup`);
      }
      if (current.resourceReceipt && current.resourceReceipt.leaseId !== leaseId) {
        throw new Error(`Worker environment ${environmentId} resource receipt lease changed`);
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
    },
    requestDestroy(input) {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
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
    },
    renewCredential(input) {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
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
        updateRow(db, environmentId, current.state, {
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
    },
    markCredentialDelivered(input): void {
      const environmentId = requireWorkerEnvironmentString(input.environmentId, "id");
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
      const result = executeWorkerEnvironmentWrite(
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
    },
    recordError(input) {
      return updateWorkerEnvironmentRecord(
        db,
        requireWorkerEnvironmentString(input.environmentId, "id"),
        input.state,
        {
          updated_at_ms: now(),
          last_error: requireWorkerEnvironmentString(input.error, "last error"),
        },
      );
    },
  } satisfies Omit<WorkerEnvironmentMutationMethods, "pruneTerminalEnvironments"> & {
    getSessionAttachmentRecord(sessionId: string): WorkerEnvironmentAttachmentRecord | undefined;
  };
}
