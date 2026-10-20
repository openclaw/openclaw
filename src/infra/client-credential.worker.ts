import type { MessagePort } from "node:worker_threads";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  isClientCredentialBusyError,
  isClientCredentialMutation,
  runClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type ClientCredentialWorkerInput = {
  root: string;
  operation: ClientCredentialOperation;
  admission: MessagePort;
};
export type ClientCredentialWorkerResult =
  | { kind: "result"; result: ClientCredentialResult }
  | { kind: "error"; error: OpenClawStateWorkerErrorPayload }
  | { kind: "busy" };

serveWorkerTasks<ClientCredentialWorkerResult, ClientCredentialWorkerInput>(
  (input, _channel, control) =>
    control.runNativeSection(() => {
      try {
        return withSqliteWorkerOperationAdmission({ port: input.admission }, () => {
          control.throwIfCancelled();
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const env = { OPENCLAW_STATE_DIR: input.root };
          const result = runClientCredentialOperation(env, input.operation, {
            readOnly: !isClientCredentialMutation(input.operation),
            beforeCommit: () => {
              control.throwIfCancelled();
              requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
            },
          });
          return { kind: "result", result };
        });
      } catch (error) {
        if (isClientCredentialBusyError(error)) {
          return { kind: "busy" };
        }
        const encoded = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
        if (encoded) {
          return { kind: "error", error: encoded };
        }
        throw error;
      } finally {
        input.admission.close();
      }
    }),
);
