import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionActorAuthorityFacts,
  SessionActorHotState,
  SessionActorOperations,
} from "./session-actor-contract.js";
import {
  projectSessionActorEntryFields,
  type SessionActorEntryWire,
  type SessionActorEntryFieldReferences,
} from "./session-actor-entry-fields.js";

type SessionActorAuthoritySnapshot =
  | {
      target: SessionActorAuthorityFacts["target"];
      entry: SessionActorEntryWire | undefined;
      entryFields?: SessionActorEntryFieldReferences;
    }
  | { target: SessionActorAuthorityFacts["target"]; entryReference: string };

/** Only an exact worker-confirmed preimage can replace unchanged entry bytes. */
export function projectSessionActorAuthority(
  state: SessionActorAuthorityFacts,
  reference?: Pick<SessionActorHotState, "entry" | "writeToken">,
  knownFields?: ReadonlySet<string>,
): SessionActorAuthoritySnapshot {
  const { target, entry } = state;
  if (reference && entry === reference.entry) {
    return { target, entryReference: reference.writeToken };
  }
  return {
    target,
    ...(knownFields ? projectSessionActorEntryFields(entry, knownFields) : { entry }),
  };
}

/** The host keeps this admitted preimage for all later authority and receipt references. */
export function projectSessionActorAdmission(
  state: SessionActorHotState,
  input: { entryReference?: string },
  knownFields: ReadonlySet<string>,
) {
  return input.entryReference === state.writeToken
    ? projectSessionActorAuthority(state, state)
    : {
        ...projectSessionActorAuthority(state, undefined, knownFields),
        writeToken: state.writeToken,
      };
}

export function isSessionActorCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SessionActorOperations> {
  return command.type.startsWith("session.actor.");
}
