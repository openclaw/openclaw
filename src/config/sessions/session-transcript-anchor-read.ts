import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import { runLockedSessionTranscriptRead } from "./session-transcript-execution-read.js";
import {
  withSessionTranscriptReadSource,
  type SessionTranscriptWorkerReadSource,
} from "./session-transcript-read-source.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

type AnchorScope = SessionTranscriptReadScope & { sessionKey: string };

/** Capture the physical source before discovery or history admission can yield. */
export async function readSessionTranscriptAnchorsAsync(
  scope: AnchorScope,
  selection: SessionTranscriptAnchorSelection,
  signal?: AbortSignal,
  /** Consume only a current snapshot, while its original writer FIFO and reader remain retained. */
  onRead?: (facts: SessionTranscriptAnchorFacts) => void,
): Promise<SessionTranscriptAnchorFacts> {
  const consume = (facts: SessionTranscriptAnchorFacts) => {
    const consumed = onRead?.(facts);
    if (isPromiseLike(consumed)) {
      void Promise.resolve(consumed).catch(() => {});
      throw new Error("Transcript anchor consumers must remain synchronous");
    }
  };
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    const facts = memory.missing
      ? {
          anchors: [],
          ...(selection.includeMetadata
            ? { metadata: { present: false, observedAt: null, updatedAt: null } }
            : {}),
          ...(selection.replayValidation?.allowInitial
            ? { replayValidated: "initial" as const }
            : {}),
        }
      : await memory.read("session.history.anchors", selection);
    memory.assertCurrent();
    consume(facts);
    return facts;
  }
  const selected =
    selection.afterSeq === undefined &&
    selection.includeMessagesForRunId === undefined &&
    getOwnedSessionTranscriptReader(scope);
  if (selected) {
    return selected.withRead(
      {
        sessionKeys: [selected.sessionKey],
        snapshotFields: [],
        transcript: { ...selection, sessionKey: selected.sessionKey },
      },
      () => signal?.throwIfAborted(),
      (read, assertCurrent) => {
        assertCurrent();
        const entry = read.entries.find((row) => row.sessionKey === selected.sessionKey)?.entry;
        if (entry?.sessionId !== scope.sessionId || !read.transcript) {
          throw new Error("Transcript anchors changed their admitted session");
        }
        consume(read.transcript);
        return read.transcript;
      },
    );
  }
  const captured = {
    agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const request = {
    entryIds: [...selection.entryIds],
    afterSeq: selection.afterSeq,
    includeMessagesForRunId: selection.includeMessagesForRunId,
    includeSession: selection.includeSession,
    includeHeader: selection.includeHeader,
    includeWatermark: selection.includeWatermark,
    includeMessagePresence: selection.includeMessagePresence,
    includeMetadata: selection.includeMetadata,
    contextValidation: selection.contextValidation && structuredClone(selection.contextValidation),
    contextAuthority: selection.contextAuthority && structuredClone(selection.contextAuthority),
    replayValidation: selection.replayValidation && { ...selection.replayValidation },
  };
  const empty: SessionTranscriptAnchorFacts = {
    anchors: [],
    ...(request.includeMetadata
      ? { metadata: { present: false, observedAt: null, updatedAt: null } }
      : {}),
    ...(request.replayValidation?.allowInitial ? { replayValidated: "initial" } : {}),
  };
  signal?.throwIfAborted();
  return withSessionTranscriptReadSource(
    captured,
    async (source) => {
      if (!source.expectedIdentity) {
        consume(empty);
        return empty;
      }
      return readSessionTranscriptAnchorsFromSource(
        {
          ...source,
          preparedReads: request.afterSeq === undefined ? source.preparedReads : undefined,
          scope: { ...source.scope, sessionKey: captured.sessionKey },
        },
        request,
        signal,
        onRead ? consume : undefined,
      );
    },
    signal,
    // Callback acceptance retains writer admission through reader failure and cleanup.
    onRead ? targetDiscoveryLane : undefined,
  );
}

/** Reuse a retained physical reader; final consumption keeps its writer FIFO and native witness. */
export async function readSessionTranscriptAnchorsFromSource(
  source: SessionTranscriptWorkerReadSource & { scope: AnchorScope },
  selection: SessionTranscriptAnchorSelection,
  signal?: AbortSignal,
  onRead?: (facts: SessionTranscriptAnchorFacts) => void,
): Promise<SessionTranscriptAnchorFacts> {
  const { resolved, owner, expectedIdentity } = source;
  const reader = source.preparedReads ?? owner;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    source.assertCurrent();
    owner.assertCurrent();
  };
  assertCurrent();
  if (!expectedIdentity) {
    const facts = { anchors: [] };
    onRead?.(facts);
    return facts;
  }
  const options = toDatabaseOptions(resolved);
  const read = async () => {
    const native = onRead ? getOpenClawAgentDatabaseIfOpen(options) : undefined;
    if (native?.db.isTransaction) {
      return { anchors: [] };
    }
    const revision = native && readSqliteNativeMutationRevision(native.db);
    const facts = await reader.readAnchors(
      {
        resolved: { ...resolved, sessionKey: resolved.sessionKey ?? source.scope.sessionKey },
        selection,
        expectedIdentity,
      },
      signal,
    );
    assertCurrent();
    // Legacy synchronous writers cannot await the FIFO. Its existing native
    // mutation witness also catches unpublished writes through that handle.
    if (
      onRead &&
      getOpenClawAgentDatabaseIfOpen(options) === native &&
      (!native ||
        (!native.db.isTransaction &&
          revision !== undefined &&
          readSqliteNativeMutationRevision(native.db) === revision))
    ) {
      onRead(facts);
    }
    return facts;
  };
  try {
    if (onRead) {
      const locked = runLockedSessionTranscriptRead(options, read, signal);
      if (locked) {
        return await locked;
      }
    }
    return onRead
      ? await runOpenClawAgentWriteAdmission(
          options,
          async (_identity, assertSource) => {
            assertCurrent();
            const facts = await read();
            assertSource();
            return facts;
          },
          true,
          undefined,
          signal,
        )
      : await read();
  } finally {
    assertCurrent();
  }
}

export async function readActiveTranscriptEntryAnchorAsync(
  scope: AnchorScope & { entryId: string },
  signal?: AbortSignal,
) {
  const result = await readSessionTranscriptAnchorsAsync(
    scope,
    { entryIds: [scope.entryId] },
    signal,
  );
  return result.anchors[0];
}
