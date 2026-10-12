import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";

type PrepareEntryPatch = (
  database: OpenClawAgentDatabase,
  sessionKey: string,
) =>
  | ((
      postimages: SessionEntryWritePostimages,
      publication: SessionEntryReplacementPublication,
    ) => void)
  | undefined;

const owners = new WeakMap<DatabaseSync, PrepareEntryPatch>();

export function registerSessionActorEntryPatchOwner(
  database: OpenClawAgentDatabase,
  prepare: PrepareEntryPatch,
): void {
  owners.set(database.db, prepare);
}

/** Only a resident actor can retain the pending and transcript facts untouched by an entry patch. */
export function prepareSessionActorEntryPatch(database: OpenClawAgentDatabase, sessionKey: string) {
  return owners.get(database.db)?.(database, sessionKey);
}
