import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SessionCreationSnapshot } from "./session-accessor.sqlite-creation-read.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type IncognitoEntryCreationOperations = {
  "session.entry.creation.prepare": {
    input: { sessionKey: string; label?: string };
    output: SessionCreationSnapshot;
  };
  "session.entry.creation.commit": {
    input: {
      sessionKey: string;
      prepared: SessionCreationSnapshot;
      entry: SessionEntry;
      label?: string;
      cwd?: string;
      owner?: SessionOwnerAssignment;
      transcriptEvents?: readonly TranscriptEvent[];
    };
    output: SessionEntry;
  };
};

export function isIncognitoEntryCreationCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoEntryCreationOperations> {
  return (
    command.type === "session.entry.creation.prepare" ||
    command.type === "session.entry.creation.commit"
  );
}
