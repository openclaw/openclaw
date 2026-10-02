import type { HeartbeatOutcomeWorkerOperations } from "../../infra/heartbeat-outcome-store.worker.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { readSessionProgressCard } from "../../session-cards/progress-card-store.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionMembershipFact } from "./session-membership-facts.types.js";
import type { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import type {
  SetSessionReactionParams,
  SessionReactionWrite,
} from "./session-reaction-store.types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";

type SharingOperations = {
  [Key in "add" | "remove" | "participant"]: {
    input: Omit<SessionSharingWorkerOperations[Key]["input"], "scope"> & { sessionKey: string };
    output: SessionSharingWorkerOperations[Key]["output"];
  };
};

/** Only these side-data commands are admitted on the inactive actor. */
export type IncognitoSideDataOperations = {
  [Key in keyof SharingOperations as `session.sharing.${Key}`]: SharingOperations[Key];
} & {
  "session.category.apply": {
    input: { from: string; to?: string };
    output: SessionSharingWorkerOperations["category.apply"]["output"];
  };
  "session.category.keys": { input: { name: string }; output: string[] };
  "session.members.read": { input: { sessionKey: string }; output: SessionMember[] };
  "session.participants.read": {
    input: { sessionKey: string };
    output: SessionParticipantRecord[];
  };
  "session.catalog.read": { input: { sessionKeys?: string[] }; output: SessionMembershipFact[] };
  "session.reactions.read": {
    input: { sessionKey: string; sessionId: string };
    output: ReturnType<typeof listSessionReactionsInDatabase>;
  };
  "session.reaction.set": {
    input: { sessionKey: string; params: SetSessionReactionParams };
    output: SessionReactionWrite;
  };
  "session.heartbeat.persist": HeartbeatOutcomeWorkerOperations["persist"];
  "session.heartbeat.claim": HeartbeatOutcomeWorkerOperations["claim"];
  "session.progressCard.get": {
    input: { sessionKey: string };
    output: ReturnType<typeof readSessionProgressCard>;
  };
};

export function isIncognitoSideDataWrite(type: keyof IncognitoSideDataOperations): boolean {
  return (
    type === "session.category.apply" ||
    type === "session.reaction.set" ||
    type.startsWith("session.sharing.") ||
    type.startsWith("session.heartbeat.")
  );
}

export function incognitoSideDataKeys(
  command: SqliteWorkerCommand<IncognitoSideDataOperations>,
): string[] {
  if (command.type === "session.heartbeat.persist") {
    return [command.input.session_key];
  }
  if (command.type === "session.catalog.read") {
    return command.input.sessionKeys ?? [];
  }
  return "sessionKey" in command.input ? [command.input.sessionKey] : [];
}
