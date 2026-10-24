import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
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
  ): SessionActorStoredState | undefined;
  rewrite<T>(database: OpenClawAgentDatabase, rewrite: Rewrite, run: () => T): T;
};

const owners = new WeakMap<OpenClawAgentDatabase["db"], RewriteOwner>();

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
  const state =
    readSessionActorTransactionState(database, scope) ??
    owners.get(database.db)?.read(database, scope);
  const current = state?.hot;
  const projection = state?.transcript.projection;
  const generation = current?.transcript.version.generation;
  if (
    !state ||
    current?.entry?.sessionId !== scope.sessionId ||
    state.transcript.coldArchive ||
    !generation ||
    !projection ||
    projection.needsRebuild ||
    projection.hasUnclassifiedEvents ||
    projection.indexedSeq !== current.transcript.version.rawSeq
  ) {
    return undefined;
  }
  const row = entryId ? state.transcript.identities.get(entryId) : undefined;
  const active = row && state.transcript.active.get(row.seq);
  if (entryId && !state.transcript.complete && (!row || !active)) {
    return undefined;
  }
  return {
    entry: {
      sessionId: current.entry.sessionId,
      lifecycleRevision: current.entry.lifecycleRevision,
      activeWriterRunId: current.entry.activeWriterRunId,
    },
    generation,
    anchor:
      row && active?.message_position != null
        ? {
            agentId: state.agentId,
            sessionKey: current.target.sessionKey,
            sessionId: current.entry.sessionId,
            storePath: state.path,
            generation,
            entryId: row.event_id,
            rawSeq: row.seq,
            effectiveParentId: row.parent_id,
            activeMessagePosition: active.message_position,
            ...(row.message_idempotency_key ? { idempotencyKey: row.message_idempotency_key } : {}),
          }
        : undefined,
  };
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
