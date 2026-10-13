import type { ContextEngineTurnOutboxWorkerOperations } from "../../agents/harness/context-engine-turn-outbox.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";

/** Actor outbox operations retain one exact session, including drain acknowledgments. */
export type IncognitoOutboxOperations = {
  [Key in keyof ContextEngineTurnOutboxWorkerOperations as `session.outbox.${Key}`]: {
    input: ContextEngineTurnOutboxWorkerOperations[Key]["input"] & {
      sessionKey: string;
      sessionId: string;
    };
    output: ContextEngineTurnOutboxWorkerOperations[Key]["output"];
  };
};

const commandTypes: ReadonlySet<string> = new Set([
  "session.outbox.prepareRun",
  "session.outbox.listPendingSessions",
  "session.outbox.readNextPending",
  "session.outbox.complete",
  "session.outbox.recordFailure",
  "session.outbox.hasPending",
  "session.outbox.enqueueIntent",
  "session.outbox.acceptIntent",
  "session.outbox.publishClosedTurn",
  "session.outbox.discardIntent",
] satisfies (keyof IncognitoOutboxOperations)[]);

export function isIncognitoOutboxCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoOutboxOperations> {
  return commandTypes.has(command.type);
}
