import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";

type LiveInputIdentity<Owner> = {
  promotedOwner?: Owner;
  workerDatabasePath: string;
  sessionId: string;
  sessionKey: string;
  transcriptInputId: string;
  idempotencyKey: string;
};

/** A promoted input can outlive its pending row while another turn still owns it. */
export function collectForeignLiveSessionPendingInputEntries<
  Owner extends LiveInputIdentity<Owner>,
>(params: {
  scope: ResolvedTranscriptScope;
  liveOwners: Iterable<Owner>;
  currentOwner: Owner | undefined;
  assertCurrent: (owner: Owner) => void;
}): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(params.scope));
  for (const source of params.liveOwners) {
    const owner = source.promotedOwner ?? source;
    if (
      owner === params.currentOwner ||
      (owner.workerDatabasePath !== databasePath &&
        !isSameOpenClawAgentDatabasePath(owner.workerDatabasePath, databasePath)) ||
      owner.sessionId !== params.scope.sessionId ||
      owner.sessionKey !== params.scope.sessionKey
    ) {
      continue;
    }
    try {
      params.assertCurrent(owner);
      entries.set(owner.transcriptInputId, owner.idempotencyKey);
    } catch {
      // Finished, cancelled, or superseded turns no longer protect an orphan.
    }
  }
  return entries;
}
