import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  listLiveSessionPendingInputIds,
  preserveSessionQueuedInputOwnersForRestart,
  type SessionPendingInputPage,
  type SessionPendingInput,
} from "./session-accessor.sqlite-pending-inputs.js";
import { prepareSqliteScope } from "./session-accessor.sqlite-scope.js";
import { hasSessionActorEmptyPendingInputHistory } from "./session-actor-replica.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type {
  PendingInputHistoryQuery,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import { projectSessionPendingInput } from "./session-pending-input-value.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type Scope = SessionAccessScope & { agentId: string; sessionId: string };

/** Capture live queue custody now; preserve it only after the session marker commits. */
export async function captureSessionQueuedInputsForRestart(scope: Scope) {
  const captured = captureSessionStoreReadTarget(
    scope,
    "Queued shutdown inputs changed their database owner",
  );
  const resolved = await prepareSqliteScope(scope);
  const physical = captured.resolve(resolved);
  physical.assertCurrent();
  const queuedInputIds = listLiveSessionPendingInputIds(
    physical.identity.canonicalPath,
    resolved.sessionKey,
    scope.sessionId,
    true,
  );
  return {
    queuedInputIds,
    preserve: () => {
      physical.assertCurrent();
      preserveSessionQueuedInputOwnersForRestart(queuedInputIds);
    },
  };
}

async function readPendingInputRows(
  scope: Scope,
  options: Omit<PendingInputHistoryQuery, "sessionKey" | "sessionId">,
  onRead?: (snapshot: PendingInputHistorySnapshot) => void,
): Promise<PendingInputHistorySnapshot> {
  const currentWindow = (snapshot: PendingInputHistorySnapshot): PendingInputHistorySnapshot =>
    snapshot.rows.length > 0 && snapshot.currentSessionId !== scope.sessionId
      ? { rows: [], total: 0 }
      : snapshot;
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(scope, authority);
  if (memory) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          lifetime: { assertCurrent() {}, assertReadable() {} },
          authority: memory.authority,
        },
        (binding) => {
          const query = {
            ...options,
            sessionKey: binding.actor.target.sessionKey,
            sessionId: scope.sessionId,
            liveInputIds: listLiveSessionPendingInputIds(
              binding.path,
              binding.actor.target.sessionKey,
              scope.sessionId,
            ),
          };
          if (onRead) {
            const snapshot = currentWindow(
              binding.actor.storage!.readCurrent(
                { type: "session.pendingInput.history", input: query },
                binding.authority,
              ),
            );
            onRead(snapshot);
            return snapshot;
          }
          return binding.actor
            .storage!.read(
              { type: "session.pendingInput.history", input: query },
              binding.authority,
            )
            .then(currentWindow);
        },
      )) ?? { rows: [], total: 0 }
    );
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const target = captureSessionStoreReadTarget(
    captured,
    "Pending input history changed its captured database owner",
  );
  const resolved = await prepareSqliteScope(captured);
  const {
    options: databaseOptions,
    identity,
    source: readSource,
    assertReadCurrent,
  } = target.resolve(resolved);
  const query = {
    ...options,
    sessionKey: resolved.sessionKey,
    sessionId: scope.sessionId,
    liveInputIds: listLiveSessionPendingInputIds(
      identity.canonicalPath,
      resolved.sessionKey,
      scope.sessionId,
    ),
  };
  if (!identity.key.startsWith("file:")) {
    return { rows: [], total: 0 };
  }
  assertReadCurrent();
  if (
    !query.queuedInputIds &&
    hasSessionActorEmptyPendingInputHistory(identity, resolved.sessionKey, query.sessionId)
  ) {
    return { rows: [], total: 0 };
  }
  return withSessionHistoryWorkerDatabase(databaseOptions, async (owner) => {
    if (onRead) {
      const { captureSessionEntryNativeMutationWitness } =
        await import("./session-entry-read-ordered.js");
      // Final consumers retain writer order through publication; reconciliation
      // belongs to ordinary history reads and must not reacquire a writer here.
      return runOpenClawAgentWriteAdmission(
        databaseOptions,
        async (_identity, assertOwner) => {
          const assertNative = captureSessionEntryNativeMutationWitness([
            { ...databaseOptions, env: captured.env },
          ]);
          const snapshot = currentWindow(
            await owner.readPendingInputHistory({
              query: { ...query, sessionKey: resolved.sessionKey },
              env: captured.env,
              source: readSource,
            }),
          );
          assertReadCurrent();
          owner.assertCurrent();
          assertOwner();
          assertNative();
          onRead(snapshot);
          return snapshot;
        },
        true,
      );
    }
    const snapshot = await owner.readPendingInputHistory({
      query: { ...query, sessionKey: resolved.sessionKey },
      env: captured.env,
      source: readSource,
    });
    assertReadCurrent();
    return currentWindow(snapshot);
  });
}

export async function listSessionPendingInputs(
  scope: Scope,
  options: { limit?: number; before?: number } = {},
): Promise<SessionPendingInputPage> {
  const { rows, total, nextBefore } = await readPendingInputRows(scope, options);
  return {
    items: rows.toReversed().map(projectSessionPendingInput),
    total: total ?? 0,
    ...(nextBefore !== undefined ? { nextBefore } : {}),
  };
}

/** Called only for a session explicitly marked by graceful shutdown. */
export async function readSessionQueuedInputPage(
  scope: Scope,
  options: { queuedInputIds: readonly string[]; before?: number },
) {
  if (options.queuedInputIds.length === 0) {
    return { rows: [], total: 0 };
  }
  return readPendingInputRows(scope, {
    ...options,
    limit: 20,
    includeTotal: false,
  });
}

export async function readSessionPendingInput(
  scope: Scope,
  id: string,
  /** Consume current facts synchronously before their physical reader and writer order are released. */
  onRead?: (input: SessionPendingInput | undefined) => void,
): Promise<SessionPendingInput | undefined> {
  const row = (
    await readPendingInputRows(
      scope,
      { id, limit: 1 },
      onRead
        ? (snapshot) => {
            const input = snapshot.rows[0];
            const result = onRead(input ? projectSessionPendingInput(input) : undefined);
            if (isPromiseLike(result)) {
              void Promise.resolve(result).catch(() => {});
              throw new Error("Pending input consumers must remain synchronous");
            }
          }
        : undefined,
    )
  ).rows[0];
  return row ? projectSessionPendingInput(row) : undefined;
}
