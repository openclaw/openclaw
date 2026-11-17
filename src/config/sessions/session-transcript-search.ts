// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionTranscriptIndexStatus } from "./session-transcript-projection-writer.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { validateSessionTranscriptSearchQuery } from "./session-transcript-search-policy.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
  SessionTranscriptSearchFilter,
} from "./session-transcript-search.types.js";
import { transcriptSearchLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Search committed memory facts or the durable worker; reconciliation remains host-owned. */
export async function searchSessionTranscripts(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: { agentId: string; path: string },
  filterCandidates?: SessionTranscriptSearchFilter,
): Promise<SessionTranscriptSearchResult> {
  validateSessionTranscriptSearchQuery(params.query);
  const memory = captureSessionActorStorageOwner(
    {
      ...params,
      storePath: preparedDatabase?.path ?? params.storePath,
    },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const query = { type: "session.history.search" as const, input: structuredClone(params) };
    if (memory.binding?.agentId === memory.agentId && memory.binding.path === memory.path) {
      return memory.binding.actor.storage!.read(query, memory.authority);
    }
    const sessionKey = memory.owner?.listSessions(memory.authority)[0]?.target.sessionKey;
    if (sessionKey) {
      const result = await withSessionActorStorage(
        { agentId: memory.agentId, storePath: memory.path, sessionKey, env: params.env },
        {
          authority: memory.authority,
          lifetime: {
            assertCurrent: () => memory.authority.assertCurrent(),
            assertReadable: () => memory.authority.assertCurrent(),
          },
        },
        (binding) => binding.actor.storage.read(query, binding.authority),
      );
      if (result) {
        return result;
      }
    }
    return { hits: [], indexing: false, truncated: false };
  }
  const scope = captureLifecycleDatabaseScope(
    preparedDatabase
      ? {
          agentId: params.agentId,
          databaseAgentId: preparedDatabase.agentId,
          path: preparedDatabase.path,
          env: params.env,
        }
      : await prepareSqliteScope({ ...params, sessionKey: params.sessionKey ?? "" }),
  );
  const options = toDatabaseOptions(scope);
  const request = {
    ...params,
    agentId: scope.agentId,
    env: scope.env,
    sessionKeys: params.sessionKeys?.slice(),
    ...(filterCandidates ? { filterCandidates: true } : {}),
  };
  let statusOwnerFailure: { error: unknown } | undefined;
  const readIndexStatus = async (
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    assertCurrent?.();
    let indexing: boolean;
    try {
      if (statusOwnerFailure) {
        throw statusOwnerFailure.error;
      }
      indexing = await readSessionTranscriptIndexStatus(options, assertCurrent, signal);
    } catch {
      // Writable maintenance failure must not discard an authorized read-only result.
      signal?.throwIfAborted();
      assertCurrent?.();
      return true;
    }
    signal?.throwIfAborted();
    assertCurrent?.();
    if (indexing) {
      startSessionTranscriptIndexReconcile(options);
    }
    return indexing;
  };
  let execution: OpenClawAgentDatabaseExecution | undefined;
  try {
    try {
      // Retain writer admission while the search checks projection readiness.
      if (supportsOpenClawAgentDatabaseExecution(options)) {
        execution = captureOpenClawAgentDatabaseExecution(options);
      }
    } catch (error) {
      statusOwnerFailure = { error };
    }
    return await withSessionHistoryWorkerDatabase(
      options,
      async (owner) => {
        const result = await owner.searchTranscripts(
          request,
          (signal) => readIndexStatus(owner.assertCurrent, signal),
          filterCandidates,
        );
        owner.assertCurrent();
        return {
          ...result,
          indexing: result.indexing || isSessionTranscriptIndexReconcileRunning(options),
        };
      },
      transcriptSearchLane,
    );
  } catch (error) {
    if (error instanceof WorkerTaskError && error.code === "timeout") {
      throw new WorkerTaskError(
        "Session transcript search timed out; narrow the session selection or use more specific query keywords, then retry. A timeout does not mean that no matching conversation exists.",
        "timeout",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await execution?.release();
  }
}
