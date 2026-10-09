import type { SessionTranscriptProjectionSelection } from "../../gateway/session-transcript-read.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";

export function resolveIncognitoHistoryProjectionSelection(
  command: SqliteWorkerCommand<IncognitoHistoryOperations>,
): SessionTranscriptProjectionSelection | undefined {
  switch (command.type) {
    case "session.history.delta":
      return { kind: "delta", options: command.input.options };
    case "session.history.count":
      return { kind: "count" };
    case "session.history.recent":
      return { kind: "recent", options: command.input.options };
    case "session.history.page":
      return { kind: "page", options: command.input.options };
    case "session.history.around-id":
      return { kind: "around-id", options: command.input.options };
    case "session.history.source":
      return { kind: "source", options: command.input.options };
    case "session.history.by-id":
      return { kind: "by-id", messageId: command.input.messageId, options: command.input.options };
    case "session.history.lookup":
      return { kind: "lookup", messageId: command.input.messageId };
    default:
      return undefined;
  }
}
