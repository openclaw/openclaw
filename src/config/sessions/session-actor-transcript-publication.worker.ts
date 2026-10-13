import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";

type Rewrite = {
  sessionKey: string;
  sessionId: string;
  rows: SessionActorTranscriptRow[];
};
type RewriteOwner = <T>(database: OpenClawAgentDatabase, rewrite: Rewrite, run: () => T) => T;

const owners = new WeakMap<DatabaseSync, RewriteOwner>();

export function registerSessionActorTranscriptRewriteOwner(
  database: OpenClawAgentDatabase,
  rewrite: RewriteOwner,
): void {
  owners.set(database.db, rewrite);
}

/** Borrow the existing resident owner only for admission- and projection-preserving rewrites. */
export function withSessionActorTranscriptRewrite<T>(
  database: OpenClawAgentDatabase,
  rewrite: Rewrite,
  run: () => T,
): T {
  const owner = owners.get(database.db);
  return owner ? owner(database, rewrite, run) : run();
}
