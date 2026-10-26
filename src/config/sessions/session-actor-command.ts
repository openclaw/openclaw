import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionActorAuthorityFacts,
  SessionActorOperations,
} from "./session-actor-contract.js";

/** Admission carries entry policy and its target; replica revisions stay in commands and receipts. */
export function projectSessionActorAuthority(
  state: SessionActorAuthorityFacts,
): SessionActorAuthorityFacts {
  const { target, entry } = state;
  return { target, entry };
}

export function isSessionActorCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SessionActorOperations> {
  return command.type.startsWith("session.actor.");
}
