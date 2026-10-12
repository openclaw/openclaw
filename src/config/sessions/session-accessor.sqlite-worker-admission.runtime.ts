import { MessagePort } from "node:worker_threads";
import { withSqliteWorkerOperationAdmissionAsync } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  withOpenClawAgentDatabaseAdmission,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabaseWriteAdmission,
} from "../../state/openclaw-agent-db.js";
import { SqliteReclamationRequestRefusedError } from "./session-accessor.sqlite-reclamation-commit.js";

export function withWorkerWriteAdmission<T>(
  port: MessagePort,
  operationId: number,
  databaseOptions: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  assertSourceCurrent?: () => void,
): Promise<T> {
  let finalAdmission = false;
  const withAdmission: OpenClawAgentDatabaseWriteAdmission = async (run) => {
    const admission = await new Promise<{
      allowed: boolean;
      validation?: OpenClawAgentDatabaseValidation;
      databaseAdmissionPort?: MessagePort;
    }>((resolve, reject) => {
      const receive = (admissionMessage: {
        type: string;
        operationId: number;
        allowed: boolean;
        validation?: OpenClawAgentDatabaseValidation;
        databaseAdmissionPort?: MessagePort;
      }) => {
        cleanup();
        resolve(admissionMessage);
      };
      const closed = () => {
        cleanup();
        reject(new Error("SQLite reclamation parent closed during database admission"));
      };
      const cleanup = () => {
        port.off("message", receive);
        port.off("close", closed);
      };
      port.on("message", receive);
      port.once("close", closed);
      port.postMessage({
        type: "admission-request",
        operationId,
      });
    });
    const invoke = () =>
      run(() => {
        if (!admission.allowed) {
          throw new SqliteReclamationRequestRefusedError(
            "SQLite reclamation database admission was revoked",
          );
        }
        assertSourceCurrent?.();
      }, admission.validation);
    const metadata = admission.databaseAdmissionPort;
    const value = await (async () => {
      try {
        return metadata instanceof MessagePort
          ? await withSqliteWorkerOperationAdmissionAsync({ port: metadata }, invoke)
          : await invoke();
      } finally {
        metadata?.close();
      }
    })();
    if (!finalAdmission) {
      port.postMessage({
        type: "admission-release",
        operationId,
      });
    }
    return value;
  };
  return withOpenClawAgentDatabaseAdmission(databaseOptions, withAdmission, (database) => {
    finalAdmission = true;
    return operation(database);
  });
}
