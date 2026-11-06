import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { prepareSkillLibraryUploadChunk, uploadSkillLibraryInDatabase } from "./import.kernel.js";
import {
  hydrateSkillLibraryWorkerAuthority,
  mutateSkillLibraryInDatabase,
  publishSkillLibraryInDatabase,
} from "./service.kernel.js";
import {
  ensureSkillLibrarySchema,
  requireSkillLibraryProfile,
  requireSkillLibraryUploadMetadata,
} from "./store.js";
import type {
  SkillLibraryMutateInput,
  SkillLibraryPublishInput,
  SkillLibraryUploadInput,
} from "./store.worker-contract.js";

const admit = (stage: "transaction" | "commit", facts?: unknown) =>
  requestSqliteWorkerOperationAdmission({ stage, facts });

export const skillLibraryOperations = {
  "skillLibrary.publish": (input: SkillLibraryPublishInput, { open, stateOptions }) => {
    const options = { database: open(), ...stateOptions() };
    ensureSkillLibrarySchema(options, admit);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        admit("transaction");
        const result = publishSkillLibraryInDatabase(db, input);
        admit("commit", result);
        const authority = hydrateSkillLibraryWorkerAuthority(input.authority);
        requireSkillLibraryProfile(db, authority);
        if (input.uploadId) {
          requireSkillLibraryUploadMetadata(db, input.uploadId, authority);
        }
        deferSqliteWorkerCommitReceipt(db, result);
        return result;
      },
      options,
      { operationLabel: "skills.library.publish" },
    );
  },
  "skillLibrary.mutate": (input: SkillLibraryMutateInput, { open, stateOptions }) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        admit("transaction");
        const result = mutateSkillLibraryInDatabase(db, input);
        admit("commit", result);
        requireSkillLibraryProfile(db, hydrateSkillLibraryWorkerAuthority(input.authority));
        deferSqliteWorkerCommitReceipt(db, result);
        return result;
      },
      { database: open(), ...stateOptions() },
      { operationLabel: "skills.library.mutate" },
    ),
  "skillLibrary.upload": (input: SkillLibraryUploadInput, { open, stateOptions }) => {
    const bytes = prepareSkillLibraryUploadChunk(input.params);
    const options = { database: open(), ...stateOptions() };
    requireSkillLibraryProfile(
      options.database.db,
      hydrateSkillLibraryWorkerAuthority(input.authority),
    );
    ensureSkillLibrarySchema(options, admit);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        admit("transaction");
        const result = uploadSkillLibraryInDatabase(db, input, bytes);
        admit("commit", result);
        requireSkillLibraryUploadMetadata(
          db,
          result.uploadId,
          hydrateSkillLibraryWorkerAuthority(input.authority),
        );
        deferSqliteWorkerCommitReceipt(db, result);
        return result;
      },
      options,
      { operationLabel: "skills.library.upload" },
    );
  },
} satisfies WorkerOperationHandlers;
