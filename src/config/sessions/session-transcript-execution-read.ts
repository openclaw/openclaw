import { AsyncLocalStorage } from "node:async_hooks";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-contract.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import type { SessionTranscriptExecutionReadResult } from "./session-transcript-execution-read.types.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

export type PreparedSessionTranscriptReads = Pick<
  SessionHistoryWorkerDatabase,
  | "readRawDelta"
  | "readVisibleDelta"
  | "readSessionMemoryCapture"
  | "readColdMetadata"
  | "readAnchors"
  | "readWatermark"
>;

type LockedTranscriptReads = {
  canonicalPath: string;
  claim: AgentDatabaseGenerationClaim;
  worker: AgentDatabaseExecutionScope;
  assertCurrent: () => void;
  queue: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  parent?: LockedTranscriptReads;
};

// Native locks and bundled SDK readers must see the same invocation capability.
const lockedTranscriptReads = resolveGlobalSingleton(
  Symbol.for("openclaw.lockedSessionTranscriptReads"),
  () => new AsyncLocalStorage<LockedTranscriptReads>(),
);

/** Borrow the lock's worker and settlement queue, never reacquire its writer reservation. */
export function withLockedSessionTranscriptReads<T>(
  context: Omit<LockedTranscriptReads, "parent">,
  run: () => T,
): T {
  return lockedTranscriptReads.run({ ...context, parent: lockedTranscriptReads.getStore() }, run);
}

function findLockedTranscriptReads(identity: DatabasePathIdentity) {
  let inherited = lockedTranscriptReads.getStore();
  while (
    inherited &&
    `file:${inherited.claim.identity}` !== identity.key &&
    inherited.canonicalPath !== identity.canonicalPath
  ) {
    inherited = inherited.parent;
  }
  return inherited;
}

/** Keep a compound read and its synchronous acceptance in the matching lock's FIFO turn. */
export function runLockedSessionTranscriptRead<T>(
  options: OpenClawAgentDatabaseOptions,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> | undefined {
  if (!lockedTranscriptReads.getStore()) {
    return undefined;
  }
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const identity = readDatabasePathIdentitySync(pathname);
  const locked = findLockedTranscriptReads(identity);
  if (!locked) {
    return undefined;
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    locked.assertCurrent();
    locked.claim.assertCurrent();
    if (`file:${locked.claim.identity}` !== identity.key) {
      throw new Error("Transcript reader belongs to another locked database generation");
    }
  };
  return locked.queue(async () => {
    assertCurrent();
    const result = await withTranscriptLockSettlement((queue) =>
      withLockedSessionTranscriptReads({ ...locked, assertCurrent, queue }, read),
    );
    assertCurrent();
    return result;
  }, signal);
}

/** Ordinary reads use WAL snapshots; an active transcript lock lends its ordered connection. */
export function createPreparedSessionTranscriptReads(params: {
  claim: AgentDatabaseGenerationClaim;
  expectedIdentity: DatabasePathIdentity;
  assertCurrent: () => void;
  reader: PreparedSessionTranscriptReads;
}): PreparedSessionTranscriptReads {
  const { claim, expectedIdentity } = params;
  const assertCurrent = () => {
    params.assertCurrent();
    claim.assertCurrent();
    if (`file:${claim.identity}` !== expectedIdentity.key) {
      throw new Error("Transcript reader belongs to another prepared database generation");
    }
  };
  const read = async <T>(
    operation: (
      worker: AgentDatabaseExecutionScope,
    ) => Promise<SessionTranscriptExecutionReadResult<T>>,
    snapshot: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    assertCurrent();
    const locked = findLockedTranscriptReads(expectedIdentity);
    if (locked) {
      return locked.queue(async () => {
        signal?.throwIfAborted();
        assertCurrent();
        locked.assertCurrent();
        locked.claim.assertCurrent();
        if (
          locked.claim.identity !== claim.identity ||
          locked.claim.incarnation !== claim.incarnation
        ) {
          throw new Error("Transcript reader belongs to another locked database generation");
        }
        const result = await operation(locked.worker);
        signal?.throwIfAborted();
        locked.assertCurrent();
        assertCurrent();
        if (!result.ok) {
          throw decodeSessionTranscriptWorkerReadError(result.error);
        }
        return result.value;
      }, signal);
    }
    const result = await snapshot();
    signal?.throwIfAborted();
    assertCurrent();
    return result;
  };
  const reader =
    <Input extends object, Value>(
      snapshot: (input: Input, signal?: AbortSignal) => Promise<Value>,
      operation: (
        worker: AgentDatabaseExecutionScope,
        input: Input,
        signal?: AbortSignal,
      ) => Promise<SessionTranscriptExecutionReadResult<Value>>,
    ) =>
    (input: Input, signal?: AbortSignal) =>
      read(
        (worker) => operation(worker, input, signal),
        () => snapshot({ ...input, expectedIdentity }, signal),
        signal,
      );
  return {
    readWatermark: reader(params.reader.readWatermark, (worker, input) =>
      worker.execute({
        type: "session.transcript.watermark.read",
        input: { ...input, expectedIdentity },
      }),
    ),
    readRawDelta: reader(params.reader.readRawDelta, (worker, input, signal) =>
      worker.execute(
        { type: "session.transcript.rawDelta.read", input: { ...input, expectedIdentity } },
        { signal },
      ),
    ),
    readVisibleDelta: reader(params.reader.readVisibleDelta, (worker, input, signal) =>
      worker.execute(
        { type: "session.transcript.visibleDelta.read", input: { ...input, expectedIdentity } },
        { signal },
      ),
    ),
    readSessionMemoryCapture: reader(
      params.reader.readSessionMemoryCapture,
      (worker, input, signal) =>
        worker.execute(
          { type: "session.transcript.memoryCapture.read", input: { ...input, expectedIdentity } },
          { signal },
        ),
    ),
    readAnchors: reader(params.reader.readAnchors, (worker, input, signal) =>
      worker.execute(
        { type: "session.transcript.anchors.read", input: { ...input, expectedIdentity } },
        { signal },
      ),
    ),
    readColdMetadata: async (input, signal) => ({
      kind: "cold-metadata",
      archive: await read(
        (worker) =>
          worker.execute(
            {
              type: "session.transcript.coldMetadata.read",
              input: { sessionId: input.sessionId, expectedIdentity },
            },
            { signal },
          ),
        async () => (await params.reader.readColdMetadata(input, signal)).archive,
        signal,
      ),
    }),
  };
}
