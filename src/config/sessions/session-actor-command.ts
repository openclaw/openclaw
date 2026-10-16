import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionActorAuthorityFacts,
  SessionActorOperations,
} from "./session-actor-contract.js";

/** Admission carries authority and receipt identity, not the resident transcript indexes. */
export function projectSessionActorAuthority(
  state: SessionActorAuthorityFacts,
): SessionActorAuthorityFacts {
  const { target, version, writeToken, dependencySessionIds, entry } = state;
  return { target, version, writeToken, dependencySessionIds, entry };
}

export function isSessionActorCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SessionActorOperations> {
  return command.type.startsWith("session.actor.");
}
