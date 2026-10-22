import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  writeSecretStoreEntryForConfigRefInDatabase,
  type SecretStoreConfigRefWrite,
} from "./secret-store-config-ref.kernel.js";
import {
  purgeExpiredSecretStoreEntriesInDatabase,
  type SecretStoreExpiryCutoffs,
} from "./secret-store-expiry.kernel.js";
import {
  deleteSecretStoreEntryInDatabase,
  rollbackSecretStoreEntryWriteInDatabase,
  updateSecretStoreAllowedHostsInDatabase,
  writeSecretStoreEntriesInDatabase,
  type SecretStoreBatchWriteParams,
} from "./secret-store-write.js";

export const secretStoreOperations = {
  "secrets.write": (
    input: Omit<SecretStoreBatchWriteParams, "database"> & {
      capturePrevious: boolean;
      now: number;
    },
    context,
  ) =>
    writeSecretStoreEntriesInDatabase(
      { ...input, database: { database: context.open(), ...context.stateOptions() } },
      input.capturePrevious,
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    ),
  "secrets.rollback": (
    input: Omit<Parameters<typeof rollbackSecretStoreEntryWriteInDatabase>[0], "database">,
    context,
  ) =>
    rollbackSecretStoreEntryWriteInDatabase(
      { ...input, database: { database: context.open(), ...context.stateOptions() } },
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    ),
  "secrets.delete": (
    input: Omit<Parameters<typeof deleteSecretStoreEntryInDatabase>[0], "database">,
    context,
  ) =>
    deleteSecretStoreEntryInDatabase(
      { ...input, database: { database: context.open(), ...context.stateOptions() } },
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    ),
  "secrets.allowedHosts": (
    input: Omit<Parameters<typeof updateSecretStoreAllowedHostsInDatabase>[0], "database">,
    context,
  ) =>
    updateSecretStoreAllowedHostsInDatabase(
      { ...input, database: { database: context.open(), ...context.stateOptions() } },
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    ),
  "secrets.purge": (input: SecretStoreExpiryCutoffs, context) =>
    purgeExpiredSecretStoreEntriesInDatabase(input, {
      database: context.open(),
      ...context.stateOptions(),
    }),
  "secrets.writeForConfigRef": (input: SecretStoreConfigRefWrite, context) =>
    writeSecretStoreEntryForConfigRefInDatabase(
      input,
      { database: context.open(), ...context.stateOptions() },
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
