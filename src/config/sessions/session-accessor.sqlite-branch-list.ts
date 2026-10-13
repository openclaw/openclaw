import { createDeferredCore } from "../../shared/deferred.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { getOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  cacheSessionBranchSummaries,
  cloneSessionBranchSummaries,
  readCachedSessionBranchSummaries,
  type SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import type { SessionBranchListParams, SessionBranchListResult } from "./session-accessor.types.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

const pendingBranchReads = new Map<string, Promise<SessionBranchSummaryReadResult>>();

export async function listSessionBranches(
  params: SessionBranchListParams,
): Promise<SessionBranchListResult> {
  const sourceKey = normalizeStoreSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const memory = captureSessionActorStorageOwner(
    { ...params, sessionKey: sourceKey },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const assertCurrent = () => {
      memory.binding?.actor.assertReadable();
      memory.authority.assertCurrent();
    };
    const actor = await memory.owner?.acquireExisting(
      resolveSqliteSessionKey(sourceKey, memory.agentId),
      { assertCurrent, assertReadable: assertCurrent },
    );
    if (!actor) {
      return { status: "missing-session" };
    }
    try {
      const result = await actor.storage!.read(
        { type: "session.history.branches", input: {} },
        { ...memory.authority, assertCurrent },
      );
      return result.status === "ok" ? { status: "ok", branches: result.branches } : result;
    } finally {
      await actor.release();
    }
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  try {
    const retained = retainOpenClawAgentDatabaseReadOnly(toDatabaseOptions(resolved));
    if (!retained.found) {
      return { status: "missing-session" };
    }
    const { database, claim } = retained;
    const completion = createDeferredCore();
    const controller = new AbortController();
    let unregister = () => {};
    try {
      const selected = readSessionEntryRow(database, sourceKey, "list")?.entry;
      if (!selected?.sessionId) {
        return { status: "missing-session" };
      }
      const expected = {
        sessionKey: sourceKey,
        sessionId: selected.sessionId,
        lifecycleRevision: selected.lifecycleRevision,
      };
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        claim.assertCurrent();
      };
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: database.agentId,
        path: database.path,
        revoke: () => controller.abort(new Error("Session branch read was revoked")),
        close: () => completion.promise,
      });
      const watermark = readSessionTranscriptHotWatermark(database, selected.sessionId);
      const cached = readCachedSessionBranchSummaries(database, selected.sessionId, watermark);
      let snapshot: SessionBranchSummaryReadResult;
      if (cached?.maxSeq === watermark.maxSeq) {
        snapshot = { status: "ok", ...cached };
      } else {
        const request = {
          database: { agentId: database.agentId, path: database.path },
          databaseIdentity: claim.identity,
          validation: getOpenClawAgentDatabaseValidation(database),
          ...expected,
        };
        // New transcripts, lifecycles, or database claims must never join an older snapshot.
        const key = JSON.stringify([request, claim.incarnation, watermark]);
        snapshot = await getOrCreatePromise(
          pendingBranchReads,
          key,
          async () => {
            const { runSessionBranchSummaryWorkerRequest } =
              await import("./session-transcript-worker-runtime.js");
            const read = () => {
              assertCurrent();
              return runSessionBranchSummaryWorkerRequest(
                { ...request, previous: cached },
                controller.signal,
              );
            };
            try {
              return await read();
            } catch (error) {
              if (!(error instanceof SessionTranscriptColdError)) {
                throw error;
              }
              // The archive worker retains restoration and commit authority; hot reads never enter it.
              return readRestoredSessionTranscript(
                { ...params, agentId: resolved.agentId, sessionId: selected.sessionId },
                read,
                { assertCurrent },
              );
            }
          },
          { evictOnSettled: true },
        );
      }
      assertCurrent();
      const current = readSessionEntryRow(database, sourceKey, "list")?.entry;
      if (
        current?.sessionId !== expected.sessionId ||
        current.lifecycleRevision !== expected.lifecycleRevision
      ) {
        return { status: "failed" };
      }
      if (snapshot.status !== "ok") {
        return snapshot;
      }
      // Keep the worker's exact watermark; an append during the read invalidates the next lookup.
      cacheSessionBranchSummaries(database, selected.sessionId, snapshot);
      return { status: "ok", branches: cloneSessionBranchSummaries(snapshot.branches) };
    } finally {
      try {
        claim.release();
      } finally {
        completion.resolve();
        unregister();
      }
    }
  } catch {
    return { status: "failed" };
  }
}
