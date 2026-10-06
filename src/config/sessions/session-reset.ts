import {
  emitSessionIdentityMutation,
  emitSessionLifecycleEvent,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type {
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
} from "./session-accessor.lifecycle-types.js";
import { bindPreparedSessionEntryPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type { SessionResetCommitted } from "./session-reset.types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

export function resetSessionEntryInWorker(
  params: ResetSessionEntryLifecycleParams,
  database: OpenClawAgentDatabaseOptions & { path: string },
  agentId: string,
  markCommitted: () => void,
): Promise<ResetSessionEntryLifecycleResult> {
  return runSessionEntryWorkerOperation<SessionResetCommitted, ResetSessionEntryLifecycleResult>({
    database,
    agentId,
    assertCurrent: () => params.commitGuard?.(),
    candidateKind: "session-reset",
    onAcknowledged(candidate) {
      markCommitted();
      if (candidate.projectionNeedsReconcile && candidate.mutation.previousSessionId) {
        startSessionTranscriptIndexReconcile({
          ...database,
          preferredSessionId: candidate.mutation.previousSessionId,
        });
      }
    },
    prepareWorker: params.resetBoundary
      ? (execution, source) => ({
          async prepare() {
            const snapshot = await execution.runExisting(source, (worker) =>
              worker.execute({
                type: "session.entry.patch.prepare",
                input: { kind: "target", target: params.target },
              }),
            );
            source.assertCurrent();
            const sessionId = snapshot?.[0]?.entry.sessionId;
            if (sessionId) {
              const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
              source.assertCurrent();
              await restoreSessionColdTranscript(
                { agentId, env: database.env, storePath: database.path, sessionId },
                () => source.assertCurrent(),
              );
              source.assertCurrent();
            }
          },
          beforeWrite: () => source.assertCurrent(),
          release: async () => {},
        })
      : undefined,
    async run(worker, commit) {
      const prepared = await worker.execute({
        type: "session.entry.patch.prepare",
        input: { kind: "target", target: params.target },
      });
      params.commitGuard?.();
      const nextEntry = await params.buildNextEntry({
        currentEntry: prepared[0] ? structuredClone(prepared[0].entry) : undefined,
        primaryKey: params.target.canonicalKey,
      });
      params.commitGuard?.();
      return commit(() =>
        worker.execute({
          type: "session.lifecycle.reset",
          input: {
            agentId,
            target: params.target,
            prepared,
            nextEntry,
            resetBoundary: params.resetBoundary,
          },
        }),
      );
    },
    async onCommitted(candidate, published, databaseIdentity) {
      if (candidate.progressCardReset) {
        emitSessionLifecycleEvent({
          agentId,
          sessionKey: candidate.previousSessionKeys[0] ?? params.target.canonicalKey,
          reason: "progress-card-reset",
        });
      }
      const mutation = candidate.mutation;
      const event: SessionIdentityMutation = {
        agentId,
        databaseIdentity,
        kind: mutation.previousEntry ? "reset" : "create",
        previous: {
          ...(mutation.previousSessionId ? { sessionId: mutation.previousSessionId } : {}),
          sessionKeys: candidate.previousSessionKeys,
        },
        current: {
          ...(mutation.nextEntry.sessionId ? { sessionId: mutation.nextEntry.sessionId } : {}),
          sessionKeys: [params.target.canonicalKey],
        },
      };
      if (published?.prepared) {
        bindPreparedSessionEntryPublication(event, {
          kind: "metadata",
          sharingChange: "changed",
          prepared: published.prepared,
        });
      }
      emitSessionIdentityMutation(event);
      await params.afterEntryMutation?.(structuredClone(mutation));
      return { ...mutation, archivedTranscripts: [] };
    },
  });
}
