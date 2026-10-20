import {
  openClientCredentialCustody,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

export type ClientCredentialWorkerOperations = {
  execute: {
    input: ClientCredentialOperation;
    output: ClientCredentialResult;
  };
};

export function createSqliteWorkerBackend(input: {
  root: string;
  createIfMissing: boolean;
  readOnly: boolean;
  timeoutMs: number;
}): SqliteWorkerBackend<ClientCredentialWorkerOperations> {
  const owner = openClientCredentialCustody({ OPENCLAW_STATE_DIR: input.root }, input);
  if (!owner) {
    throw new Error("Client credential store disappeared during admission.");
  }
  return {
    execute(command) {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      return owner.run(command.input, () =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
      );
    },
    close() {
      owner.close();
    },
  };
}

export const openExistingSqliteWorkerBackend = createSqliteWorkerBackend;
