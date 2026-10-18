import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionActorRewriteFacts = {
  entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">;
  generation: string | undefined;
  anchor: TranscriptEntryAnchor | undefined;
};

type Rewrite = {
  sessionKey: string;
  sessionId: string;
  rows: SessionActorTranscriptRow[];
};
type RewriteOwner = {
  read(
    database: OpenClawAgentDatabase,
    scope: { sessionKey: string; sessionId: string },
    entryId?: string,
  ): SessionActorRewriteFacts | undefined;
  rewrite<T>(database: OpenClawAgentDatabase, rewrite: Rewrite, run: () => T): T;
};

const owners = new WeakMap<DatabaseSync, RewriteOwner>();

export function registerSessionActorTranscriptRewriteOwner(
  database: OpenClawAgentDatabase,
  rewrite: RewriteOwner,
): void {
  owners.set(database.db, rewrite);
}

/** A covered resident is hot and reconciled; an absent anchor is an authoritative absence. */
export function readSessionActorRewriteFacts(
  database: OpenClawAgentDatabase,
  scope: { sessionKey: string; sessionId: string },
  entryId?: string,
): SessionActorRewriteFacts | undefined {
  return owners.get(database.db)?.read(database, scope, entryId);
}

/** Borrow the existing resident owner only for admission- and projection-preserving rewrites. */
export function withSessionActorTranscriptRewrite<T>(
  database: OpenClawAgentDatabase,
  rewrite: Rewrite,
  run: () => T,
): T {
  const owner = owners.get(database.db);
  return owner ? owner.rewrite(database, rewrite, run) : run();
}
