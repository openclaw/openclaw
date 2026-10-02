import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
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

export const skillUploadOperations = {
  "skillUploads.begin": (
    input: Parameters<typeof beginSkillUploadInDatabase>[0],
    { open, stateOptions },
  ) => beginSkillUploadInDatabase(input, { database: open(), ...stateOptions() }, admit),
  "skillUploads.chunk": (
    input: Parameters<typeof appendSkillUploadChunkInDatabase>[0],
    { open, stateOptions },
  ) => appendSkillUploadChunkInDatabase(input, { database: open(), ...stateOptions() }, admit),
  "skillUploads.commit": (
    input: Parameters<typeof commitSkillUploadInDatabase>[0],
    { open, stateOptions },
  ) => commitSkillUploadInDatabase(input, { database: open(), ...stateOptions() }, admit),
  "skillUploads.expired": (
    input: Parameters<typeof listExpiredSkillUploadsInDatabase>[0],
    { open, stateOptions },
  ) => listExpiredSkillUploadsInDatabase(input, { database: open(), ...stateOptions() }),
  "skillUploads.deleteExpired": (
    input: Parameters<typeof deleteExpiredSkillUploadInDatabase>[0],
    { open, stateOptions },
  ) => deleteExpiredSkillUploadInDatabase(input, { database: open(), ...stateOptions() }),
  "skillUploads.claim": (
    input: Parameters<typeof claimSkillUploadInDatabase>[0],
    { open, stateOptions },
  ) => claimSkillUploadInDatabase(input, { database: open(), ...stateOptions() }),
  "skillUploads.renew": (
    input: Omit<Parameters<typeof renewSkillUploadInstallLease>[0], "options">,
    { open, stateOptions },
  ) => renewSkillUploadInstallLease({ ...input, options: { database: open(), ...stateOptions() } }),
  "skillUploads.consume": (input: { uploadId: string; owner: string }, { open, stateOptions }) =>
    deleteOwnedSkillUpload(input.uploadId, input.owner, { database: open(), ...stateOptions() }),
  "skillUploads.release": (
    input: Parameters<typeof releaseSkillUploadInDatabase>[0],
    { open, stateOptions },
  ) => releaseSkillUploadInDatabase(input, { database: open(), ...stateOptions() }),
} satisfies WorkerOperationHandlers;
