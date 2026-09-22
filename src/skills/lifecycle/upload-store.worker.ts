import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
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

type Operation<F extends (...args: never[]) => unknown> = {
  input: Parameters<F>[0];
  output: ReturnType<F>;
};
export type SkillUploadWorkerOperations = {
  "skillUploads.begin": Operation<typeof beginSkillUploadInDatabase>;
  "skillUploads.chunk": Operation<typeof appendSkillUploadChunkInDatabase>;
  "skillUploads.commit": Operation<typeof commitSkillUploadInDatabase>;
  "skillUploads.expired": Operation<typeof listExpiredSkillUploadsInDatabase>;
  "skillUploads.deleteExpired": Operation<typeof deleteExpiredSkillUploadInDatabase>;
  "skillUploads.claim": Operation<typeof claimSkillUploadInDatabase>;
  "skillUploads.renew": {
    input: Omit<Parameters<typeof renewSkillUploadInstallLease>[0], "options">;
    output: boolean;
  };
  "skillUploads.consume": {
    input: { uploadId: string; owner: string };
    output: ReturnType<typeof deleteOwnedSkillUpload>;
  };
  "skillUploads.release": Operation<typeof releaseSkillUploadInDatabase>;
};

export function isSkillUploadCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<SkillUploadWorkerOperations> {
  return (
    command.type === "skillUploads.begin" ||
    command.type === "skillUploads.chunk" ||
    command.type === "skillUploads.commit" ||
    command.type === "skillUploads.expired" ||
    command.type === "skillUploads.deleteExpired" ||
    command.type === "skillUploads.claim" ||
    command.type === "skillUploads.renew" ||
    command.type === "skillUploads.consume" ||
    command.type === "skillUploads.release"
  );
}

export function executeSkillUploadCommand(
  command: SqliteWorkerCommand<SkillUploadWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SkillUploadWorkerOperations[keyof SkillUploadWorkerOperations]["output"] {
  switch (command.type) {
    case "skillUploads.begin":
      return beginSkillUploadInDatabase(command.input, options);
    case "skillUploads.chunk":
      return appendSkillUploadChunkInDatabase(command.input, options);
    case "skillUploads.commit":
      return commitSkillUploadInDatabase(command.input, options);
    case "skillUploads.expired":
      return listExpiredSkillUploadsInDatabase(command.input, options);
    case "skillUploads.deleteExpired":
      return deleteExpiredSkillUploadInDatabase(command.input, options);
    case "skillUploads.claim":
      return claimSkillUploadInDatabase(command.input, options);
    case "skillUploads.renew":
      return renewSkillUploadInstallLease({ ...command.input, options });
    case "skillUploads.consume":
      return deleteOwnedSkillUpload(command.input.uploadId, command.input.owner, options);
    case "skillUploads.release":
      return releaseSkillUploadInDatabase(command.input, options);
  }
}
