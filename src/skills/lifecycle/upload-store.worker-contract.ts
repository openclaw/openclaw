import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SkillUploadWorkerOperations } from "./upload-store.worker.js";

export function isSkillUploadCommand(command: {
  type: string;
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
