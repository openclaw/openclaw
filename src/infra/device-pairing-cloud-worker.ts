import type { DatabaseSync } from "node:sqlite";
import { ensureWorkerEnvironmentNodeEnrollmentSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import type { CloudWorkerSetupCompletionPublication } from "./device-pairing-read.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export function hasCloudWorkerSetupDeviceBinding(params: {
  db: DatabaseSync;
  setupId: string;
  deviceId: string;
}): boolean {
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(params.db);
  const environment = executeSqliteQueryTakeFirstSync(
    params.db,
    kysely
      .selectFrom("worker_environments")
      .select("node_device_id")
      .where("node_setup_id", "=", params.setupId),
  );
  return environment?.node_device_id === params.deviceId;
}

/** Bind one environment-owned setup completion inside the pairing transaction. */
export function bindCloudWorkerSetupCompletion(params: {
  db: DatabaseSync;
  completion: { setupId: string; deviceId: string; completedAtMs: number };
  credentialDigest: string;
}): CloudWorkerSetupCompletionPublication {
  ensureWorkerEnvironmentNodeEnrollmentSchema(params.db);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(params.db);
  const environment = executeSqliteQueryTakeFirstSync(
    params.db,
    kysely
      .selectFrom("worker_environments")
      .select([
        "environment_id",
        "state",
        "destroy_requested_at_ms",
        "node_device_id",
        "provision_operation_id",
        "owner_epoch",
        "updated_at_ms",
      ])
      .where("node_setup_id", "=", params.completion.setupId),
  );
  if (!environment) {
    throw new Error("Cloud worker setup completion has no owning environment");
  }
  const isFirstProvisioningDevice =
    environment.state === "provisioning" && environment.node_device_id === null;
  const isSameLiveDevice =
    environment.node_device_id === params.completion.deviceId &&
    ["provisioning", "bootstrapping", "ready", "idle", "attached"].includes(environment.state);
  if (
    environment.destroy_requested_at_ms !== null ||
    (!isFirstProvisioningDevice && !isSameLiveDevice)
  ) {
    throw new Error("Cloud worker setup completion owner is no longer pending");
  }
  if (isFirstProvisioningDevice) {
    requestDevicePairingMutationAdmission({
      kind: "bootstrap.cloudWorkerSetup",
      environmentId: environment.environment_id,
      setupId: params.completion.setupId,
      credentialDigest: params.credentialDigest,
      provisionOperationId: environment.provision_operation_id,
      ownerEpoch: environment.owner_epoch,
    });
  }
  executeSqliteQuerySync(
    params.db,
    kysely
      .updateTable("worker_environments")
      .set({
        node_device_id: params.completion.deviceId,
        updated_at_ms: Math.max(environment.updated_at_ms, params.completion.completedAtMs),
      })
      .where("environment_id", "=", environment.environment_id),
  );
  return {
    environmentId: environment.environment_id,
    nodeDeviceId: params.completion.deviceId,
    updatedAtMs: Math.max(environment.updated_at_ms, params.completion.completedAtMs),
  };
}
