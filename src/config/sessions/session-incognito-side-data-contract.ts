import type {
  AcpSessionEntryMutationInput,
  AcpSessionEntryMutationResult,
} from "../../acp/runtime/session-meta-entry.types.js";
import type {
  BoardReadOperations,
  BoardWriteOperations,
} from "../../boards/sqlite-board-operations.js";
import type { HeartbeatOutcomeWorkerOperations } from "../../infra/heartbeat-outcome-store.worker.js";
import type { MessageToolRunOutcomeInsert } from "../../infra/message-tool-run-outcome-store.kernel.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { readSessionProgressCard } from "../../session-cards/progress-card-store.js";
import type { ProgressCardWorkerOperations } from "../../session-cards/progress-card-store.worker.js";
import type { readLegacyAcpMigrationContextInDatabase } from "./session-accessor.sqlite-acp-provenance.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import type { SessionTitleFields } from "./session-history-read.types.js";
import type { SessionMembershipFact } from "./session-membership-facts.types.js";
import type { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import type {
  SetSessionReactionParams,
  SessionReactionWrite,
} from "./session-reaction-store.types.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type {
  SessionCollaborationMutation,
  SessionSharingWorkerOperations,
  SessionSuggestionListParams,
  StoredSessionSuggestion,
} from "./session-sharing-store.types.js";

type SharingOperations = {
  [Key in SessionCollaborationMutation]: {
    input: Omit<SessionSharingWorkerOperations[Key]["input"], "scope"> & { sessionKey: string };
    output: SessionSharingWorkerOperations[Key]["output"];
  };
};

/** Only these side-data commands are admitted on the inactive actor. */
export type IncognitoSideDataOperations = {
  [Key in keyof SharingOperations as `session.sharing.${Key}`]: SharingOperations[Key];
} & {
  [
    Key in keyof (BoardReadOperations & BoardWriteOperations) as `session.${Key}`
  ]: (BoardReadOperations & BoardWriteOperations)[Key];
} & {
  "session.row.read": {
    input: { sessionKey: string };
    output:
      | {
          row: SessionRowDatabaseFacts;
          children: SessionEntrySummary[];
          titleFields: SessionTitleFields;
          terminalModel?: { modelProvider: string; model: string };
        }
      | undefined;
  };
  "session.acp.source": {
    input: { sessionKey: string };
    output: ReturnType<typeof readLegacyAcpMigrationContextInDatabase>;
  };
  "session.acp.entry": {
    input: AcpSessionEntryMutationInput;
    output: Pick<AcpSessionEntryMutationResult, "entry">;
  };
  "session.category.apply": {
    input: { from: string; to?: string };
    output: SessionSharingWorkerOperations["category.apply"]["output"];
  };
  "session.category.keys": { input: { name: string }; output: string[] };
  "session.members.read": { input: { sessionKey: string }; output: SessionMember[] };
  "session.suggestions.read": {
    input: { sessionKey: string; params: SessionSuggestionListParams };
    output: StoredSessionSuggestion[];
  };
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
  "session.messageToolOutcome.record": { input: MessageToolRunOutcomeInsert; output: void };
  "session.progressCard.get": {
    input: { sessionKey: string };
    output: ReturnType<typeof readSessionProgressCard>;
  };
  "session.progressCard.put": {
    input: ProgressCardWorkerOperations["put"]["input"];
    output: Extract<ProgressCardWorkerOperations["put"]["output"], { ok: true }>["value"];
  };
};

export function isIncognitoSideDataWrite(type: keyof IncognitoSideDataOperations): boolean {
  return (
    type === "session.acp.entry" ||
    type === "session.category.apply" ||
    type === "session.reaction.set" ||
    type === "session.messageToolOutcome.record" ||
    type === "session.progressCard.put" ||
    type === "session.boards.applyOps" ||
    type === "session.boards.putWidget" ||
    type === "session.boards.grant" ||
    type.startsWith("session.sharing.") ||
    type.startsWith("session.heartbeat.")
  );
}

export function incognitoSideDataKeys(
  command: SqliteWorkerCommand<IncognitoSideDataOperations>,
): string[] {
  if (
    command.type === "session.heartbeat.persist" ||
    command.type === "session.messageToolOutcome.record"
  ) {
    return [command.input.session_key];
  }
  if (command.type === "session.catalog.read") {
    return command.input.sessionKeys ?? [];
  }
  return "sessionKey" in command.input ? [command.input.sessionKey] : [];
}
