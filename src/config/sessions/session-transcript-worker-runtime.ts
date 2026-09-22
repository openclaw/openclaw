import { AsyncLocalStorage } from "node:async_hooks";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import { loadSessionEntryReadOnlyInScope } from "./session-accessor.sqlite-entry.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type {
  SessionEntryWorkerInput,
  SessionBranchSummaryWorkerInput,
  SessionTranscriptHistoryWorkerInput,
  SessionRowPresenceWorkerInput,
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript.worker.js";

const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput,
  SessionTranscriptWorkerReply<"model-context">
>({
  workerUrl,
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

// Background transcript exports cannot occupy the foreground context worker.
const sessionEntries = new WorkerTaskPool<
  SessionEntryWorkerInput,
  SessionTranscriptWorkerReply<"session-entry">
>({ workerUrl, maxWorkers: 1, sharedCompute: true });

const historyPages = new WorkerTaskPool<
  SessionTranscriptHistoryWorkerInput | SessionRowPresenceWorkerInput,
  SessionTranscriptWorkerReply<"history-page" | "session-row-presence">
>({
  workerUrl,
  maxWorkers: 1,
  idleTimeoutMs: 0,
  prepareWorker: () => {
    ensureSqliteLibrarySelected();
    return { options: {} };
  },
});

// Branch scans share background compute admission without delaying foreground history or context.
const branchSummaries = new WorkerTaskPool<
  SessionBranchSummaryWorkerInput,
  SessionTranscriptWorkerReply<"branch-summaries">
>({ workerUrl, maxWorkers: 1, sharedCompute: true });

function unwrapReply<
  Kind extends
    | "model-context"
    | "session-entry"
    | "history-page"
    | "branch-summaries"
    | "session-row-presence",
>(reply: SessionTranscriptWorkerReply<Kind>) {
  if (reply.ok) {
    return reply.value;
  }
  if (reply.error.kind === "cold") {
    throw new SessionTranscriptColdError(reply.error.sessionId);
  }
  if (reply.error.kind === "projection") {
    throw new SessionTranscriptProjectionUnavailableError(reply.error.sessionId);
  }
  throw new SessionTranscriptReadFenceError(reply.error.message);
}

export async function readSessionTranscriptModelContextAsync(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
  limits?: SessionModelContextWorkerInput["limits"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  return unwrapReply<"model-context">(
    await modelContextReads.run(
      { kind: "model-context", target, admission, through, limits },
      { timeoutMs: 60_000, signal },
    ),
  );
}

export async function prepareSessionEntryInWorker(
  absPath: string,
  options: SessionEntryWorkerInput["options"],
  redaction: SensitiveTextRedactionSnapshot,
) {
  const receipt = resolveSessionTranscriptReadFence(options);
  return unwrapReply<"session-entry">(
    await sessionEntries.run(
      {
        kind: "session-entry",
        absPath,
        options,
        redaction,
        ...(receipt ? { admission: { ...receipt } } : {}),
      },
      {
        inputBytes:
          2 *
          (absPath.length +
            options.agentId.length +
            options.sessionId.length +
            options.storePath.length +
            (options.sessionKey?.length ?? 0) +
            redaction.registeredSecretValues.reduce((bytes, value) => bytes + value.length, 0)),
      },
    ),
  );
}

type HistoryDatabaseResource = {
  database: { agentId: string; path: string };
  generation: number;
  pending: number;
  revoked: boolean;
  nativeSequence?: number;
  closing?: Promise<void>;
  unregister: () => void;
};

export type SessionHistoryWorkerDatabase = {
  generation: number;
  assertCurrent: () => void;
  run: (
    prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
    inputBytes: number,
  ) => Promise<SessionHistoryWorkerResult>;
  readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
};

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope({ ...input, env });
  const resolved = resolveSqliteScope({ ...input, storePath, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const scope: SessionRowPresenceWorkerInput["scope"] = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: databasePath,
    databaseAgentId: options.agentId,
    env,
  };
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: incognito
      ? async () => loadSessionEntryReadOnlyInScope(scope) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}

const historyDatabases = new Map<string, HistoryDatabaseResource>();
const runInHistoryOwnerContext = AsyncLocalStorage.snapshot();
const historySetTimeout = setTimeout;
const historyClearTimeout = clearTimeout;
let historyIdleTimer: NodeJS.Timeout | undefined;
let historyGeneration = 0;
let historyNativeSequence = 0;
let historyRetiredSequence = 0;

function pruneHistoryDatabases(): void {
  for (const [key, resource] of historyDatabases) {
    if (resource.pending === 0 && resource.nativeSequence === undefined && !resource.closing) {
      resource.unregister();
      historyDatabases.delete(key);
    }
  }
}

function rotateHistoryWorkers(): Promise<void> {
  const through = historyNativeSequence;
  // rotate pauses dispatch synchronously; later factories receive a greater sequence.
  return historyPages.rotate().then(() => {
    historyRetiredSequence = Math.max(historyRetiredSequence, through);
    for (const resource of historyDatabases.values()) {
      if (resource.nativeSequence !== undefined && resource.nativeSequence <= through) {
        resource.nativeSequence = undefined;
      }
    }
    pruneHistoryDatabases();
  });
}

// Missing reads can leave an idle worker without retaining any database custody.
function armHistoryIdleRetirement(): void {
  historyClearTimeout(historyIdleTimer);
  if (
    historyNativeSequence <= historyRetiredSequence ||
    [...historyDatabases.values()].some((resource) => resource.pending)
  ) {
    return;
  }
  historyIdleTimer = runInHistoryOwnerContext(() =>
    historySetTimeout(() => {
      void rotateHistoryWorkers().catch((error: unknown) => {
        process.emitWarning(`Session history worker retirement failed: ${String(error)}`);
      });
    }, 30 * 60_000),
  );
  historyIdleTimer.unref();
}

/** Capture database custody before restoration or queueing can await. */
export async function withSessionHistoryWorkerDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
): Promise<T> {
  const database = {
    agentId: normalizeAgentId(options.agentId),
    path: resolveOpenClawAgentSqlitePath(options),
  };
  const key = JSON.stringify(database);
  let resource = historyDatabases.get(key);
  if (!resource || resource.revoked) {
    const owned: HistoryDatabaseResource = {
      database,
      generation: ++historyGeneration,
      pending: 0,
      revoked: false,
      unregister: () => {},
    };
    const close = () => {
      if (!owned.closing) {
        owned.closing = rotateHistoryWorkers().finally(() => {
          owned.closing = undefined;
          pruneHistoryDatabases();
          armHistoryIdleRetirement();
        });
        void owned.closing.catch(() => {});
      }
      return owned.closing;
    };
    owned.unregister = registerOpenClawAgentDatabaseAsyncResource({
      ...database,
      revoke: () => {
        owned.revoked = true;
        void close();
      },
      close,
    });
    historyDatabases.set(key, owned);
    resource = owned;
  }
  const owned = resource;
  const assertCurrent = () => {
    if (owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
  };
  historyClearTimeout(historyIdleTimer);
  owned.pending++;
  try {
    assertCurrent();
    const runRequest = async <TResult>(
      prepare: () =>
        | Omit<SessionTranscriptHistoryWorkerInput, "database">
        | Omit<SessionRowPresenceWorkerInput, "database">,
      inputBytes: number,
      receive: (value: SessionHistoryWorkerResult | boolean) => TResult,
    ): Promise<TResult> => {
      assertCurrent();
      let sequence = 0;
      try {
        const reply = await historyPages.run(
          () => {
            assertCurrent();
            const input = prepare();
            assertCurrent();
            sequence = ++historyNativeSequence;
            owned.nativeSequence = sequence;
            return { ...input, database };
          },
          { inputBytes, timeoutMs: 60_000 },
        );
        const value = receive(unwrapReply<"history-page" | "session-row-presence">(reply));
        if (reply.ok && reply.closedHistoryDatabase) {
          const closed = historyDatabases.get(JSON.stringify(reply.closedHistoryDatabase));
          // A later dispatched request may already hold this target's next native custody.
          if (closed?.nativeSequence !== undefined && closed.nativeSequence <= sequence) {
            closed.nativeSequence = undefined;
          }
        }
        assertCurrent();
        return value;
      } catch (error) {
        if (sequence > 0) {
          await rotateHistoryWorkers();
        }
        throw error;
      }
    };
    const result = await operation({
      generation: owned.generation,
      assertCurrent,
      run: async (prepare, inputBytes) =>
        await runRequest(prepare, inputBytes, (value) => {
          if (typeof value === "boolean") {
            throw new Error("Session history worker returned metadata presence instead of history");
          }
          return value;
        }),
      readEntryPresence: async (scope) =>
        await runRequest(
          () => ({ kind: "session-row-presence", scope }),
          JSON.stringify(scope).length * 2,
          (value) => {
            if (typeof value !== "boolean") {
              throw new Error(
                "Session history worker returned history instead of metadata presence",
              );
            }
            return value;
          },
        ),
    });
    assertCurrent();
    return result;
  } finally {
    owned.pending--;
    pruneHistoryDatabases();
    armHistoryIdleRetirement();
  }
}

export async function runSessionBranchSummaryWorkerRequest(
  request: SessionBranchSummaryReadRequest,
  signal: AbortSignal,
) {
  return unwrapReply<"branch-summaries">(
    await branchSummaries.run(
      { kind: "branch-summaries", request },
      {
        inputBytes:
          2 *
          (request.database.agentId.length +
            request.database.path.length +
            request.databaseIdentity.length +
            request.sessionKey.length +
            request.sessionId.length +
            (request.lifecycleRevision?.length ?? 0)),
        timeoutMs: 60_000,
        signal,
      },
    ),
  );
}
