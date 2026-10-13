import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-write-contract.js";

export type IncognitoManagerOperations = {
  [
    Key in keyof SessionMetadataWorkerOperations as Key extends `session.${infer Operation}`
      ? `session.manager.${Operation}`
      : never
  ]: {
    input: {
      sessionKey: string;
      command: { type: Key; input: SessionMetadataWorkerOperations[Key]["input"] };
    };
    output: SessionMetadataWorkerOperations[Key]["output"];
  };
};

export function isIncognitoManagerCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoManagerOperations> {
  return command.type.startsWith("session.manager.");
}

export function isIncognitoManagerWrite(type: keyof IncognitoManagerOperations): boolean {
  return type !== "session.manager.metadata.mutation";
}

export function toIncognitoManagerCommand<
  Key extends keyof SessionMetadataWorkerOperations,
>(command: {
  type: Key;
  input: SessionMetadataWorkerOperations[Key]["input"];
}): SqliteWorkerCommand<IncognitoManagerOperations> {
  const mapped = {
    type: `session.manager.${command.type.slice("session.".length)}`,
    input: { sessionKey: command.input.scope.sessionKey, command },
  };
  // SAFETY: the mapped contract preserves each metadata command and its result unchanged.
  return mapped as SqliteWorkerCommand<IncognitoManagerOperations>;
}
