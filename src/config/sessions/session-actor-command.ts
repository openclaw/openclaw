import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SessionActorOperations } from "./session-actor-contract.js";

export function isSessionActorCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SessionActorOperations> {
  return command.type.startsWith("session.actor.");
}
