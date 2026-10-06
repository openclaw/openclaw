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
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";

type WorkerTranscriptSourceIdentity = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "archivedAt"
>;

export function resolveWorkerTurnTranscriptTarget(
  turn: Pick<SessionPlacementTurnParams, "agentId" | "sessionId" | "sessionKey" | "sessionTarget">,
): BoundAgentRunSessionTarget {
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
  const currentEntry = loadSessionEntry({
    agentId: turn.sessionTarget.agentId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
  });
  if (
    currentEntry?.sessionId !== turn.sessionId ||
    (turn.sessionTarget.expectedLifecycleRevision !== undefined &&
      currentEntry.lifecycleRevision !== turn.sessionTarget.expectedLifecycleRevision) ||
    (turn.sessionTarget.expectedWriterRunId !== undefined &&
      currentEntry.activeWriterRunId !== turn.sessionTarget.expectedWriterRunId)
  ) {
    throw new Error("Cloud worker transcript identity is no longer current");
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
    : ["sessionId"];
  if (!predicate && captured.expectedLifecycleRevision !== undefined) {
    fields.push("lifecycleRevision");
  }
  if (!predicate && captured.expectedWriterRunId !== undefined) {
    fields.push("activeWriterRunId");
  }
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
