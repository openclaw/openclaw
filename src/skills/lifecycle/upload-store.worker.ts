import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { commitSkillUploadInDatabase } from "./upload-store-commit.js";
import {
  appendSkillUploadChunkInDatabase,
  beginSkillUploadInDatabase,
  claimSkillUploadInDatabase,
  deleteExpiredSkillUploadInDatabase,
  listExpiredSkillUploadsInDatabase,
  releaseSkillUploadInDatabase,
} from "./upload-store.kernel.js";
import { deleteOwnedSkillUpload, renewSkillUploadInstallLease } from "./upload-store.sqlite.js";

const admit = (stage: "transaction" | "commit") =>
  requestSqliteWorkerOperationAdmission({ stage, facts: undefined });

function withDatabase<Input, Output>(
  operation: (
    input: Input,
    options: Parameters<typeof beginSkillUploadInDatabase>[1],
    admission?: typeof admit,
  ) => Output,
  admission?: typeof admit,
) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext): Output =>
    operation(input, { database: open(), ...stateOptions() }, admission);
}

export const skillUploadOperations = {
  "skillUploads.begin": withDatabase(beginSkillUploadInDatabase, admit),
  "skillUploads.chunk": withDatabase(appendSkillUploadChunkInDatabase, admit),
  "skillUploads.commit": withDatabase(commitSkillUploadInDatabase, admit),
  "skillUploads.expired": withDatabase(listExpiredSkillUploadsInDatabase),
  "skillUploads.deleteExpired": withDatabase(deleteExpiredSkillUploadInDatabase),
  "skillUploads.claim": withDatabase(claimSkillUploadInDatabase),
  "skillUploads.renew": (
    input: Omit<Parameters<typeof renewSkillUploadInstallLease>[0], "options">,
    { open, stateOptions },
  ) => renewSkillUploadInstallLease({ ...input, options: { database: open(), ...stateOptions() } }),
  "skillUploads.consume": (input: { uploadId: string; owner: string }, { open, stateOptions }) =>
    deleteOwnedSkillUpload(input.uploadId, input.owner, { database: open(), ...stateOptions() }),
  "skillUploads.release": withDatabase(releaseSkillUploadInDatabase),
} satisfies WorkerOperationHandlers;
