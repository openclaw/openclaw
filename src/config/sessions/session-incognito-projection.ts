import { randomUUID } from "node:crypto";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoComputeTarget } from "./session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import { drainTranscriptIndexStatus } from "./session-transcript-index-maintenance.js";
import type { TranscriptProjectionRebuildOperations } from "./session-transcript-projection-publication.worker.js";
import type { ProjectionPublisher } from "./session-transcript-projection-writer.js";
import type { MemoryTranscriptProjectionFrame } from "./session-transcript-reconcile-memory.js";

export type IncognitoProjectionBinding = {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target?: IncognitoComputeTarget;
};
export type IncognitoProjectionSource = {
  sessionIds: string[];
  pending: boolean;
  publication: ProjectionPublisher;
  read(sessionId: string): Promise<MemoryTranscriptProjectionFrame>;
  sweep?(): Promise<boolean>;
};

/** Retain compute custody while individual frames and publications take their own FIFO turn. */
export function withIncognitoProjection<T>(
  binding: IncognitoProjectionBinding,
  database: OpenClawAgentDatabaseOptions & { preferredSessionId?: string },
  operation: (source: IncognitoProjectionSource) => Promise<T>,
): Promise<T> {
  const { actor, authority } = binding;
  const target = structuredClone(binding.target);
  if (
    actor.path !== resolveOpenClawAgentSqlitePath(database) ||
    actor.agentId !== database.agentId
  ) {
    throw new Error("Incognito reconciliation belongs to another actor");
  }
  return actor.sessions.withCompute(authority, target, async (compute) => {
    const { targets, hasMore } = target
      ? { targets: [target], hasMore: false }
      : await drainTranscriptIndexStatus(() =>
          compute.execute({ type: "session.compute.store.preflight", input: {} }),
        );
    const preferred = database.preferredSessionId;
    targets.sort(
      (left, right) => Number(right.sessionId === preferred) - Number(left.sessionId === preferred),
    );
    const sources = new Map(
      targets.map((entry) => [entry.sessionId, { ...entry, sourceId: randomUUID() }]),
    );
    const sourceFor = (sessionId: string) => {
      const source = sources.get(sessionId);
      if (!source) {
        throw new Error("Incognito projection requested an unselected transcript");
      }
      return source;
    };
    for (const source of sources.values()) {
      await compute.execute({ type: "session.compute.source.open", input: source });
    }
    const publishers: {
      [Key in keyof TranscriptProjectionRebuildOperations]: (
        input: TranscriptProjectionRebuildOperations[Key]["input"],
      ) => Promise<TranscriptProjectionRebuildOperations[Key]["output"]>;
    } = {
      claim: (request) =>
        compute.execute({
          type: "session.compute.projection.claim",
          input: { ...sourceFor(request.plan.sessionId), request },
        }),
      deleteChunk: (request) =>
        compute.execute({
          type: "session.compute.projection.deleteChunk",
          input: { ...sourceFor(request.sessionId), request },
        }),
      appendChunk: (request) =>
        compute.execute({
          type: "session.compute.projection.appendChunk",
          input: { ...sourceFor(request.sessionId), request },
        }),
      finalize: (request) =>
        compute.execute({
          type: "session.compute.projection.finalize",
          input: { ...sourceFor(request.plan.sessionId), request },
        }),
    };
    const publication: ProjectionPublisher = {
      execute: ({ type, input }) => publishers[type](input),
    };
    return operation({
      sessionIds: [...sources.keys()],
      pending: hasMore,
      publication,
      read: (sessionId) =>
        compute.execute({ type: "session.compute.source.read", input: sourceFor(sessionId) }),
      ...(target
        ? {}
        : {
            async sweep() {
              const swept = await drainTranscriptIndexStatus(() =>
                compute.execute({ type: "session.compute.store.sweep", input: {} }),
              );
              return swept.hasMore || swept.sessionIds.length > 0;
            },
          }),
    });
  });
}
