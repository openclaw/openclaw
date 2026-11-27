import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SessionActorOperations } from "./session-actor-contract.js";

export function transcriptPayloadBytes(
  command: SqliteWorkerCommand<SessionActorOperations>,
): number | undefined {
  if (
    command.type !== "session.actor.appendTranscriptEvent" &&
    command.type !== "session.actor.appendToolResult"
  ) {
    return undefined;
  }
  const input = command.input;
  if (input.append) {
    const append = input.append;
    if (append.kind === "message") {
      return Buffer.byteLength(append.input.messageJson);
    }
    return (
      Buffer.byteLength(
        typeof append.input.event === "string"
          ? append.input.event
          : JSON.stringify(append.input.event),
      ) +
      Buffer.byteLength(append.input.message?.messageJson ?? "") +
      (append.input.initialModel ? Buffer.byteLength(JSON.stringify(append.input.initialModel)) : 0)
    );
  }
  if ("eventJson" in input) {
    return Buffer.byteLength(input.eventJson);
  }
  return input.turn.options.messages.reduce(
    (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.message)),
    0,
  );
}
