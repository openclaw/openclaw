import nodePath from "node:path";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { retainSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../../config/sessions/transcript-target-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseRuntime } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";

type WorkerTranscriptSourceIdentity = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "archivedAt"
>;

type WorkerTranscriptTurn = Pick<
  SessionPlacementTurnParams,
  "agentId" | "sessionId" | "sessionKey" | "sessionTarget"
>;

function captureWorkerTurnTranscriptTarget(turn: WorkerTranscriptTurn): BoundAgentRunSessionTarget {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const targetKeyAgentId = parseAgentSessionKey(turn.sessionTarget.sessionKey)?.agentId;
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey) ||
    (targetKeyAgentId && targetKeyAgentId !== turn.sessionTarget.agentId)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
    expectedLifecycleRevision: turn.sessionTarget.expectedLifecycleRevision,
    expectedWriterRunId: turn.sessionTarget.expectedWriterRunId,
  };
}

export function resolveWorkerTurnTranscriptTarget(
  turn: WorkerTranscriptTurn,
): BoundAgentRunSessionTarget {
  const target = captureWorkerTurnTranscriptTarget(turn);
  const currentEntry = loadSessionEntry(target);
  if (
    currentEntry?.sessionId !== target.sessionId ||
    (target.expectedLifecycleRevision !== undefined &&
      currentEntry.lifecycleRevision !== target.expectedLifecycleRevision) ||
    (target.expectedWriterRunId !== undefined &&
      currentEntry.activeWriterRunId !== target.expectedWriterRunId)
  ) {
    throw new Error("Cloud worker transcript identity is no longer current");
  }
  return target;
}

/** Keep native compatibility guards on the worker-admitted handle through turn settlement. */
export async function withWorkerTurnTranscriptDatabase<T>(
  turn: WorkerTranscriptTurn,
  controls: {
    assertCurrent(): void;
    prepareAuthority(): Promise<Pick<PlacementTurnClaimAuthority, "isCurrent" | "release">>;
    signal?: AbortSignal;
  },
  run: (target: BoundAgentRunSessionTarget) => Promise<T>,
): Promise<T> {
  const captured = captureWorkerTurnTranscriptTarget(turn);
  const target = { ...captured, storePath: nodePath.resolve(captured.storePath) };
  let executing = false;
  let authority: Awaited<ReturnType<typeof controls.prepareAuthority>> | undefined;
  const assertPreparing = () => {
    // Execution owns subsequent liveness and can settle after releasing its placement claim.
    if (executing) {
      return;
    }
    controls.signal?.throwIfAborted();
    if (authority && !authority.isCurrent()) {
      throw new Error("Cloud worker placement authority changed during preparation");
    }
    const current = captureWorkerTurnTranscriptTarget(turn);
    if (
      current.agentId !== target.agentId ||
      current.sessionId !== target.sessionId ||
      current.sessionKey !== target.sessionKey ||
      nodePath.resolve(current.storePath) !== target.storePath ||
      current.expectedLifecycleRevision !== target.expectedLifecycleRevision ||
      current.expectedWriterRunId !== target.expectedWriterRunId
    ) {
      throw new Error("Cloud worker transcript target changed during preparation");
    }
  };
  const runAdmitted = async (pinned: BoundAgentRunSessionTarget) => {
    controls.assertCurrent();
    const current = resolveWorkerTurnTranscriptTarget({ ...pinned, sessionTarget: pinned });
    executing = true;
    const originalSessionTarget = turn.sessionTarget;
    turn.sessionTarget = current;
    try {
      return await run(current);
    } finally {
      turn.sessionTarget = originalSessionTarget;
    }
  };
  controls.assertCurrent();
  return withSessionEntryReadOnlyInWorker(target, assertPreparing, async (read, owner) => {
    controls.assertCurrent();
    if (!read.ok) {
      throw read.error;
    }
    if (!read.value || read.value.sessionId !== target.sessionId) {
      throw new Error("Cloud worker transcript identity is no longer current");
    }
    authority = await controls.prepareAuthority();
    try {
      controls.assertCurrent();
      const scope = owner.scope;
      if (!scope) {
        assertPreparing();
        return await runAdmitted(target);
      }
      const pinned = { ...target, storePath: scope.storePath };
      const assertAdmission = () => {
        owner.assertCurrent();
        assertPreparing();
      };
      return await withOpenClawAgentDatabaseRuntime(
        { agentId: scope.databaseAgentId, path: scope.storePath, env: scope.env },
        () => {
          assertAdmission();
          return runAdmitted(pinned);
        },
        assertAdmission,
        controls.signal,
      );
    } finally {
      authority.release();
      authority = undefined;
    }
  });
}

/** Reuse the accepted turn identity as a transaction-local source predicate. */
export function captureWorkerTurnTranscriptSource(
  target: BoundAgentRunSessionTarget,
  predicate?: {
    fields: (keyof WorkerTranscriptSourceIdentity)[];
    expected: WorkerTranscriptSourceIdentity;
    refuse: () => never;
  },
): SessionSourceAssertion {
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const resolved = resolveSqliteScope({ ...target, env });
  const options = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath(options);
  const incognito = isIncognitoOpenClawAgentSqlitePath(path, options);
  const identity = readDatabasePathIdentitySync(path);
  const refuse =
    predicate?.refuse ??
    ((): never => {
      throw new Error("Cloud worker transcript identity is no longer current");
    });
  const captured = { ...target, sessionKey: resolved.sessionKey, storePath: path };
  const assertCurrent = () => {
    if (incognito) {
      return;
    }
    if (!identity.key.startsWith("file:")) {
      refuse();
    }
    assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
  };
  const expected: WorkerTranscriptSourceIdentity = predicate
    ? { ...predicate.expected }
    : {
        sessionId: captured.sessionId,
        ...(captured.expectedLifecycleRevision !== undefined
          ? { lifecycleRevision: captured.expectedLifecycleRevision }
          : {}),
        ...(captured.expectedWriterRunId !== undefined
          ? { activeWriterRunId: captured.expectedWriterRunId }
          : {}),
      };
  const fields: (keyof WorkerTranscriptSourceIdentity)[] = predicate
    ? [...predicate.fields]
    : (["sessionId", "lifecycleRevision", "activeWriterRunId"] as const).filter((field) =>
        Object.hasOwn(expected, field),
      );
  const assertEntry = (entry: WorkerTranscriptSourceIdentity | undefined) => {
    if (!entry || fields.some((field) => entry[field] !== expected[field])) {
      refuse();
    }
  };
  const assertNative = () => {
    assertCurrent();
    assertEntry(loadSessionEntryReadOnly({ ...captured, env }));
  };
  if (incognito) {
    return Object.assign(assertNative, { nativeSource: true });
  }
  return Object.assign(assertNative, {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      assertCurrent();
      const retained = retainSessionHistoryWorkerDatabase({ ...options, path, env });
      try {
        const snapshot = await retained.owner.readExactEntries({
          env,
          sessionKeys: [captured.sessionKey],
          projection: "exact",
          snapshotFields: [],
        });
        const entry = snapshot.entries[0]?.entry;
        const assertPrepared = () => {
          assertCurrent();
          retained.owner.assertCurrent();
          if (
            snapshot.source?.databaseIdentity !== identity.key.slice("file:".length) ||
            snapshot.source.databaseBirthtime !== identity.birthtime
          ) {
            refuse();
          }
          assertEntry(entry);
        };
        assertPrepared();
        return {
          assertCurrent: assertPrepared,
          checks: [
            {
              predicate: {
                source: {
                  agentId: options.agentId,
                  path,
                  databaseIdentity: identity.key.slice("file:".length),
                  databaseBirthtime: identity.birthtime,
                },
                sessionKey: captured.sessionKey,
                fields,
                expected,
              },
              refuse,
            },
          ],
          release: retained.release,
        };
      } catch (error) {
        await releaseSessionSourceAuthorities([retained], [error]);
        throw error;
      }
    },
  });
}
