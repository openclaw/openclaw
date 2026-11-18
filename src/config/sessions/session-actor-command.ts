import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionActorAuthorityFacts,
  SessionActorHotState,
  SessionActorOperations,
} from "./session-actor-contract.js";

type SessionActorAuthoritySnapshot =
  | SessionActorAuthorityFacts
  | { target: SessionActorAuthorityFacts["target"]; entryReference: string };

/** Only an exact worker-confirmed preimage can replace unchanged entry bytes. */
export function projectSessionActorAuthority(
  state: SessionActorAuthorityFacts,
  reference?: Pick<SessionActorHotState, "entry" | "writeToken">,
): SessionActorAuthoritySnapshot {
  const { target, entry } = state;
  if (reference && entry === reference.entry) {
    return { target, entryReference: reference.writeToken };
  }
  return { target, entry };
}

export function isSessionActorCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SessionActorOperations> {
  return command.type.startsWith("session.actor.");
}
