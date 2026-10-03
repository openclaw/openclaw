import { randomUUID } from "node:crypto";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import type { IncognitoComputeTarget } from "./session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";
import type { ProjectionPublisher } from "./session-transcript-projection-writer.js";
import type { MemoryTranscriptProjectionFrame } from "./session-transcript-reconcile-memory.js";

export type IncognitoProjectionBinding = {
  actor: IncognitoAgentDatabaseExecution;
  authority: IncognitoSessionAuthority;
  target: IncognitoComputeTarget;
};
export type IncognitoProjectionSource = {
  sessionId: string;
  publication: ProjectionPublisher;
  read(): Promise<MemoryTranscriptProjectionFrame>;
};

/** Retain compute custody while individual frames and publications take their own FIFO turn. */
export function withIncognitoProjection<T>(
  binding: IncognitoProjectionBinding,
  database: OpenClawAgentDatabaseOptions,
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
    const sourceId = randomUUID();
    await compute.execute({
      type: "session.compute.source.open",
      input: { ...target, sourceId },
    });
    const publishers: {
      [Key in keyof TranscriptProjectionPublicationOperations]: (
        input: TranscriptProjectionPublicationOperations[Key]["input"],
      ) => Promise<TranscriptProjectionPublicationOperations[Key]["output"]>;
    } = {
      claim: (request) =>
        compute.execute({
          type: "session.compute.projection.claim",
          input: { ...target, sourceId, request },
        }),
      deleteChunk: (request) =>
        compute.execute({
          type: "session.compute.projection.deleteChunk",
          input: { ...target, sourceId, request },
        }),
      appendChunk: (request) =>
        compute.execute({
          type: "session.compute.projection.appendChunk",
          input: { ...target, sourceId, request },
        }),
      finalize: (request) =>
        compute.execute({
          type: "session.compute.projection.finalize",
          input: { ...target, sourceId, request },
        }),
      preflight: () => {
        throw new Error("Incognito projection does not admit store-wide operations");
      },
      sweep: () => {
        throw new Error("Incognito projection does not admit store-wide operations");
      },
    };
    const publication: ProjectionPublisher = {
      execute: ({ type, input }) => publishers[type](input),
    };
    return operation({
      sessionId: target.sessionId,
      publication,
      read: () =>
        compute.execute({ type: "session.compute.source.read", input: { ...target, sourceId } }),
    });
  });
}
