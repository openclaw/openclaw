import type { SessionMetadataOperations } from "./session-manager-write-contract.js";

export type SessionActorMemoryMetadataReads = Pick<
  SessionMetadataOperations,
  "session.metadata.mutation"
>;
export type SessionActorMemoryMetadataWrites = Omit<
  SessionMetadataOperations,
  "session.metadata.mutation"
>;
export type SessionActorMemoryMetadataCommand = {
  [Key in keyof SessionMetadataOperations]: {
    type: Key;
    input: SessionMetadataOperations[Key]["input"];
  };
}[keyof SessionMetadataOperations];
