import {
  isSessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "./session-artifact-read.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";

export type { SessionTranscriptReadScope } from "./session-transcript-read-kernel.js";
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-entry-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.sqlite-active-events.js";

const sessionTranscriptReader = createSessionTranscriptReader({
  resolveTarget: resolveTranscriptReadTarget,
  readSnapshot: async (target, read, options) => {
    const scope = toTranscriptReadScope(target);
    return readRestoredSessionTranscript(
      scope,
      () => withCurrentProjectionSnapshot(scope, read, options),
      options,
    );
  },
});
// Callback consumers retain their native snapshot; artifact selection uses the typed worker below.
export const { visitSessionMessagesAsync } = sessionTranscriptReader;

function usesProcessHeldTranscript(scope: SessionTranscriptReadScope): boolean {
  // Incognito SQLite belongs to this process and cannot be reopened in a worker.
  return Boolean(
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      })),
  );
}

function captureHistoryReadScope(scope: SessionTranscriptReadScope): SessionTranscriptReadScope {
  const target = bindSessionTranscriptStoreScope(scope);
  return {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
    sessionEntry: target.sessionEntry ? { sessionId: target.sessionEntry.sessionId } : undefined,
    env: captureSessionTranscriptStorageEnvironment(target.env ?? process.env),
  };
}

export async function readSessionMessagesAsync(
  ...args: Parameters<typeof sessionTranscriptReader.readSessionMessagesAsync>
): Promise<unknown[]> {
  return (await readSessionMessagesWithSourceAsync(...args)).messages;
}

function createHistoryPageReader<Options, Result>(
  readLocal: (target: SessionTranscriptReadScope, options: Options) => Promise<Result>,
  readWorker: (
    read: typeof import("../config/sessions/session-history-worker-runtime.js").readSessionHistoryPageInWorker,
    target: SessionTranscriptReadScope,
    options: Options,
  ) => Promise<Result>,
) {
  return async (scope: SessionTranscriptReadScope, inputOptions: Options): Promise<Result> => {
    const target = captureHistoryReadScope(scope);
    const options = structuredClone(inputOptions);
    if (usesProcessHeldTranscript(target)) {
      return readLocal(target, options);
    }
    const { readSessionHistoryPageInWorker } =
      await import("../config/sessions/session-history-worker-runtime.js");
    return readWorker(readSessionHistoryPageInWorker, target, options);
  };
}

export const readSessionMessagesWithSourceAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesWithSourceAsync,
  (read, target, options) => read({ kind: "source-messages", params: { target, options } }),
);

export const readRecentSessionMessagesWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readRecentSessionMessagesWithStatsAsync,
  (read, target, options) => read({ kind: "recent-page", params: { target, options } }),
);

export const readSessionMessagesPageWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesPageWithStatsAsync,
  (read, target, options) => read({ kind: "message-page", params: { target, options } }),
);

export const readSessionMessagesAroundIdWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesAroundIdWithStatsAsync,
  (read, target, options) => read({ kind: "around-id", params: { target, options } }),
);

export function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "list" }>,
): Promise<Extract<SessionArtifactReadResult, { kind: "list" }>>;
export function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "image-page" }>,
): Promise<Extract<SessionArtifactReadResult, { kind: "image-page" }>>;
export function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "image" }>,
): Promise<Extract<SessionArtifactReadResult, { kind: "image" }>>;
export function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "download-grant" }>,
): Promise<Extract<SessionArtifactReadResult, { kind: "download-grant" }>>;
export function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "download-response" }>,
): Promise<Extract<SessionArtifactReadResult, { kind: "download-response" }>>;
export async function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionArtifactReadQuery,
): Promise<SessionArtifactReadResult> {
  const target = captureHistoryReadScope(scope);
  const query = structuredClone(inputQuery);
  if (usesProcessHeldTranscript(target)) {
    const { selectSessionArtifacts } = await import("./session-artifact-read.js");
    return selectSessionArtifacts(target, query, sessionTranscriptReader);
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "artifacts", params: { target, query } });
}

export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  options?: Parameters<typeof sessionTranscriptReader.readSessionMessageByIdAsync>[2],
) {
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    return sessionTranscriptReader.readSessionMessageByIdAsync(target, messageId, options);
  }
  const capturedOptions = options ? { ...options } : undefined;
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "message-by-id",
    params: { target, messageId, options: capturedOptions },
  });
}

/** Keep exact membership and its full-history validation in the admitted history worker. */
export async function readSessionMessagesMatchingIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
): Promise<unknown[]> {
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    return sessionTranscriptReader.readSessionMessagesMatchingIdAsync(target, messageId);
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "message-lookup",
    params: { target, messageId },
  });
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = captureHistoryReadScope(scope);
  const inProcess = usesProcessHeldTranscript(target);
  const readCount = async () => {
    if (inProcess) {
      return sessionTranscriptReader.readSessionMessageCountAsync(target);
    }
    const { readSessionHistoryPageInWorker } =
      await import("../config/sessions/session-history-worker-runtime.js");
    return readSessionHistoryPageInWorker({ kind: "message-count", params: { target } });
  };
  try {
    return await readCount();
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(target);
    return await readCount();
  }
}
