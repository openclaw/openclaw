import type { MessagePort } from "node:worker_threads";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { ClientCredentialMigrationRequiredError } from "./client-credential-readiness.js";
import {
  isClientCredentialBusyError,
  isClientCredentialMutation,
  openClientCredentialCustody,
  runClientCredentialOperation,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type ClientCredentialPreparation = {
  kind: "preparation";
  state: "ready" | "upgrade" | "required";
};
export type ClientCredentialWorkerOperation =
  | ClientCredentialOperation
  | { kind: "startup.prepare" };
export type ClientCredentialWorkerInput = {
  root: string;
  operation: ClientCredentialWorkerOperation;
  admission: MessagePort;
};
export type ClientCredentialWorkerResult =
  | { kind: "result"; result: ClientCredentialResult | ClientCredentialPreparation }
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
          const beforeCommit = () => {
            control.throwIfCancelled();
            requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          };
          if (input.operation.kind === "startup.prepare") {
            using owner = openClientCredentialCustody(env, {}, beforeCommit);
            return {
              kind: "result",
              result: {
                kind: "preparation",
                state: owner?.needsMetadataUpgrade ? "upgrade" : "ready",
              },
            };
          }
          const result = runClientCredentialOperation(env, input.operation, {
            readOnly: !isClientCredentialMutation(input.operation),
            beforeCommit,
          });
          return { kind: "result", result };
        });
      } catch (error) {
        if (
          input.operation.kind === "startup.prepare" &&
          error instanceof ClientCredentialMigrationRequiredError
        ) {
          return { kind: "result", result: { kind: "preparation", state: "required" } };
        }
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
