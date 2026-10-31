import { loadOrCreateConfigRevisionKeyInDatabase } from "../gateway/config-revision-key.worker.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeConfigMachineStateKey } from "./config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import { authProfileCredentialPublication } from "./user-model-account-authority.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const machineStateOperations = {
  "machineState.configRevisionKey": (
    input: { candidateKey: Uint8Array },
    context: WorkerWriteOperationContext,
  ) =>
    loadOrCreateConfigRevisionKeyInDatabase(
      context.open(),
      input.candidateKey,
      context.stateOptions(),
    ),
  "machineState.write": (
    input: { key: string; value: unknown },
    context: WorkerWriteOperationContext,
  ) => {
    const key = normalizeConfigMachineStateKey(input.key);
    return context.write(
      ({ db }) => {
        if (key !== "authProfiles.store") {
          return writeConfigMachineStateInDatabase(db, key, input.value);
        }
        const { result, receipt } = authProfileCredentialPublication.capture(
          sqlPublicationAnchor(db),
          () => writeConfigMachineStateInDatabase(db, key, input.value),
        );
        deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(db), {
          authCredentials: authProfileCredentialPublication.bound(receipt),
        });
        return result;
      },
      {
        operationLabel: "config-machine-state.write",
        singleStatement: key === "authProfiles.store" ? undefined : true,
      },
    );
  },
};

export type MachineStateWorkerOperations = WorkerOperations<typeof machineStateOperations>;
