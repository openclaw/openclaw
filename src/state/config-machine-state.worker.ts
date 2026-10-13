import { loadOrCreateConfigRevisionKeyInDatabase } from "../gateway/config-revision-key.worker.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import { normalizeConfigMachineStateKey } from "./config-machine-state.js";
import { authProfileCredentialPublication } from "./user-model-account-authority.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const machineStateOperations = {
  "machineState.configRevisionKey": (
    input: { candidateKey: Uint8Array },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(({ db }) => loadOrCreateConfigRevisionKeyInDatabase(db, input.candidateKey), {
      operationLabel: "gateway.config-revision-key.load",
    }),
  "machineState.write": (
    input: { key: string; value: unknown },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
        const key = normalizeConfigMachineStateKey(input.key);
        if (key !== "authProfiles.store") {
          return writeConfigMachineStateInDatabase(db, key, input.value);
        }
        const { result, receipt } = authProfileCredentialPublication.capture(db, () =>
          writeConfigMachineStateInDatabase(db, key, input.value),
        );
        deferSqliteWorkerCommitReceipt(db, {
          authCredentials: authProfileCredentialPublication.bound(receipt),
        });
        return result;
      },
      { operationLabel: "config-machine-state.write" },
    ),
};

export type MachineStateWorkerOperations = WorkerOperations<typeof machineStateOperations>;
