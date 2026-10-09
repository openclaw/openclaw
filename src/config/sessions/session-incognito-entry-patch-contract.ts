import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import type { InternalSessionEntry } from "./types.js";

export type IncognitoEntryPatchResult = {
  entry: InternalSessionEntry | null;
  wrote: boolean;
  transcriptPredicate?: SessionEntryPatchCommitted["transcriptPredicate"];
  refusedSource?: SessionEntryPatchCommitted["refusedSource"];
};

export type IncognitoEntryPatchOperations = {
  "session.entry.patch.prepare": {
    input: { sessionKey: string; selection: SessionEntryPatchSelection };
    output: SqliteLifecycleTargetSnapshot;
  };
  "session.entry.patch.commit": {
    input: SessionEntryPatchCommit;
    output: IncognitoEntryPatchResult;
  };
};

export function isIncognitoEntryPatchCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoEntryPatchOperations> {
  return (
    command.type === "session.entry.patch.prepare" || command.type === "session.entry.patch.commit"
  );
}
