import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  cacheSessionBranchSummaries,
  cloneSessionBranchSummaries,
  readCachedSessionBranchSummaries,
  type SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
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
  try {
    const resolved = await prepareSqliteScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.env ? { env: params.env } : {}),
      sessionKey: sourceKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
    });
    const options = toDatabaseOptions(resolved);
    const database = { agentId: options.agentId, path: resolveOpenClawAgentSqlitePath(options) };
    const writeToken = readSqliteDatabaseWriteTokenForPath(database.path);
    const cached = readCachedSessionBranchSummaries(database.path, sourceKey, writeToken);
    if (writeToken !== undefined && cached?.writeToken === writeToken) {
      return { status: "ok", branches: cloneSessionBranchSummaries(cached.branches) };
    }
    const key = JSON.stringify([database.path, sourceKey, writeToken]);
    const snapshot = await getOrCreatePromise(
      pendingBranchReads,
      key,
      async () => {
        const { runSessionBranchSummaryWorkerRequest } =
          await import("./session-transcript-worker-runtime.js");
        const read = () =>
          runSessionBranchSummaryWorkerRequest({
            database,
            sessionKey: sourceKey,
            previous: cached,
          });
        try {
          return await read();
        } catch (error) {
          if (!(error instanceof SessionTranscriptColdError)) {
            throw error;
          }
          return readRestoredSessionTranscript(
            { ...params, agentId: resolved.agentId, sessionId: error.sessionId },
            read,
          );
        }
      },
      { evictOnSettled: true },
    );
    if (snapshot.status !== "ok") {
      return snapshot;
    }
    // A concurrent write may finish this snapshot; its receipt invalidates the next lookup.
    cacheSessionBranchSummaries(database.path, sourceKey, writeToken, snapshot);
    return { status: "ok", branches: cloneSessionBranchSummaries(snapshot.branches) };
  } catch {
    return { status: "failed" };
  }
}
