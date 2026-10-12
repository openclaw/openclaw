/** Worker entrypoint for transcript parsing and active-branch resolution only. */
import { MessagePort } from "node:worker_threads";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../../state/openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { SqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import type { TranscriptIndexEntry } from "./session-transcript-projection-append.js";
import {
  prepareSessionTranscriptProjection,
  type PreparedSessionTranscriptProjection,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";

const ACTIVE_ROWS_PER_CHUNK = 512;
const FTS_ROWS_PER_CHUNK = 128;
const FTS_TEXT_BYTES_PER_CHUNK = 256 * 1024;

type ReconcileWorkerOwner = {
  stateDir: string;
  externallySupervised: boolean;
};

type ReconcileWorkerPlanInput = ReconcileWorkerOwner & {
  agentId: string;
  path: string;
  sessionIds: string[];
};

export type SessionTranscriptReconcileWorkerInput =
  | (ReconcileWorkerPlanInput & { mode: "disk"; leaseId: string })
  | (ReconcileWorkerOwner & { mode: "release"; leaseId: string; path: string });

export type SessionTranscriptReconcileWorkerTask = {
  input: SessionTranscriptReconcileWorkerInput;
  port: MessagePort;
  coordination?: SqliteMutationWorkerCoordination;
  sourceIdentity?: string;
};

export type EncodedTranscriptFtsChunk = {
  rows: Array<{
    messageId: string;
    role: "assistant" | "user";
    textByteLength: number;
    textByteOffset: number;
    timestamp: number;
  }>;
  textBytes: Uint8Array<ArrayBuffer>;
};

export type SessionTranscriptReconcileWorkerMessage =
  | {
      type: "active-chunk";
      rows: PreparedSessionTranscriptProjection["activeRows"];
      sessionId: string;
    }
  | { type: "done"; yielded: boolean }
  | { type: "failed"; error: string }
  | { type: "lease-released" }
  | { type: "lease-release-failed"; error: string }
  | { type: "fts-chunk"; chunk: EncodedTranscriptFtsChunk; sessionId: string }
  | { type: "plan-finish"; sessionId: string }
  | { type: "plan-start"; plan: PreparedSessionTranscriptProjectionMetadata };

type SessionTranscriptReconcileWorkerCommand = {
  accepted: boolean;
  type: "continue";
  yield?: true;
};

function resolveLeaseEnvironment(owner: ReconcileWorkerOwner) {
  return {
    OPENCLAW_STATE_DIR: owner.stateDir,
    ...(owner.externallySupervised ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
}

function releaseLease(
  owner: ReconcileWorkerOwner & { leaseId: string; path: string },
  port: MessagePort,
  readOnlyClosed = false,
): void {
  let failure: Error | undefined;
  try {
    releaseOpenClawAgentDatabaseLease(
      owner.leaseId,
      { env: resolveLeaseEnvironment(owner), initializationAgentPaths: [owner.path] },
      readOnlyClosed ? "read-only" : undefined,
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    closeOpenClawStateDatabase();
  }
  if (failure) {
    port.postMessage({
      type: "lease-release-failed",
      error: failure.message,
    } satisfies SessionTranscriptReconcileWorkerMessage);
  } else {
    port.postMessage({ type: "lease-released" } satisfies SessionTranscriptReconcileWorkerMessage);
  }
  port.close();
}

function waitForMessage<T>(port: MessagePort): Promise<T> {
  return new Promise((resolve) => {
    port.once("message", resolve);
  });
}

async function postAndWait(
  port: MessagePort,
  message: SessionTranscriptReconcileWorkerMessage,
  transferList: ArrayBuffer[] = [],
): Promise<SessionTranscriptReconcileWorkerCommand> {
  port.postMessage(message, transferList);
  return await waitForMessage<SessionTranscriptReconcileWorkerCommand>(port);
}

function encodeFtsChunk(rows: readonly TranscriptIndexEntry[]): EncodedTranscriptFtsChunk {
  const encoder = new TextEncoder();
  const encoded = rows.map((row) => ({ bytes: encoder.encode(row.text), row }));
  const textBytes = new Uint8Array(encoded.reduce((total, entry) => total + entry.bytes.length, 0));
  let textByteOffset = 0;
  const metadata = encoded.map(({ bytes, row }) => {
    textBytes.set(bytes, textByteOffset);
    const result = {
      messageId: row.messageId,
      role: row.role,
      textByteLength: bytes.length,
      textByteOffset,
      timestamp: row.timestamp,
    };
    textByteOffset += bytes.length;
    return result;
  });
  return { rows: metadata, textBytes };
}

function takeFtsChunkEnd(rows: readonly TranscriptIndexEntry[], start: number): number {
  let bytes = 0;
  let end = start;
  while (end < rows.length && end - start < FTS_ROWS_PER_CHUNK) {
    const rowBytes = Buffer.byteLength(rows[end]?.text ?? "", "utf8");
    if (end > start && bytes + rowBytes > FTS_TEXT_BYTES_PER_CHUNK) {
      break;
    }
    bytes += rowBytes;
    end += 1;
  }
  return end;
}

async function streamPreparedProjection(
  plan: PreparedSessionTranscriptProjection,
  port: MessagePort,
): Promise<boolean> {
  const { activeRows, ftsRows, ...metadata } = plan;
  if (!(await postAndWait(port, { type: "plan-start", plan: metadata })).accepted) {
    return false;
  }
  for (let offset = 0; offset < activeRows.length; offset += ACTIVE_ROWS_PER_CHUNK) {
    if (
      !(
        await postAndWait(port, {
          type: "active-chunk",
          rows: activeRows.slice(offset, offset + ACTIVE_ROWS_PER_CHUNK),
          sessionId: plan.sessionId,
        })
      ).accepted
    ) {
      return false;
    }
  }
  for (let offset = 0; offset < ftsRows.length;) {
    const end = takeFtsChunkEnd(ftsRows, offset);
    const chunk = encodeFtsChunk(ftsRows.slice(offset, end));
    const reply = await postAndWait(port, { type: "fts-chunk", chunk, sessionId: plan.sessionId }, [
      chunk.textBytes.buffer,
    ]);
    if (!reply.accepted) {
      return false;
    }
    offset = end;
  }
  return (
    (await postAndWait(port, { type: "plan-finish", sessionId: plan.sessionId })).yield === true
  );
}

async function run(
  input: SessionTranscriptReconcileWorkerInput,
  port: MessagePort,
  coordination?: SqliteMutationWorkerCoordination,
  sourceIdentity?: string,
): Promise<void> {
  const assertSource = () => {
    if (input.mode === "disk") {
      if (!sourceIdentity) {
        throw new Error("Transcript worker lost its captured source identity");
      }
      assertExistingDatabaseIdentity(input.path, sourceIdentity);
    }
  };
  if (input.mode === "release") {
    releaseLease(input, port);
    return;
  }
  const reconcileInput = input;
  let closeDatabase: (() => void) | undefined;
  let terminalMessage: Extract<
    SessionTranscriptReconcileWorkerMessage,
    { type: "done" | "failed" }
  >;
  try {
    const database = (() => {
      const options = {
        agentId: reconcileInput.agentId,
        path: reconcileInput.path,
        env: resolveLeaseEnvironment(reconcileInput),
      };
      assertSource();
      if (coordination?.reconciliation) {
        assertExistingDatabaseIdentity(
          coordination.databasePath,
          coordination.reconciliation.identity,
        );
      }
      // The parent knows this identity before admission, even if native exit prevents a reply.
      claimOpenClawAgentDatabaseLease(options, reconcileInput.leaseId);
      const opened = openOpenClawAgentDatabaseReadOnly(options);
      if (!opened.found) {
        throw new Error(`Cannot prepare transcript indexes: ${opened.reason}`);
      }
      closeDatabase = opened.database.close;
      return opened.database;
    })();
    const sessionIds = reconcileInput.sessionIds;
    let yielded = false;
    for (const [index, sessionId] of sessionIds.entries()) {
      const plan = prepareSessionTranscriptProjection(database.db, sessionId);
      if (plan) {
        if (await streamPreparedProjection(plan, port)) {
          yielded = index < sessionIds.length - 1;
          break;
        }
      }
    }
    terminalMessage = { type: "done", yielded };
  } catch (error) {
    terminalMessage = {
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The original read handle and lease remain pinned through the final native phase.
  if (!coordination?.reconciliation) {
    closeDatabase?.();
  }
  port.postMessage(terminalMessage);
  // The final parent write must finish before this independent deletion fence is released.
  await waitForMessage(port);
  // Cleanup uses the handles and lease opened by this task, even after retirement.
  if (coordination?.reconciliation) {
    closeDatabase?.();
  }
  releaseLease(reconcileInput, port, closeDatabase !== undefined);
}

serveWorkerTasks(
  async (value) => {
    if (!value || typeof value !== "object" || !("input" in value) || !("port" in value)) {
      throw new Error("session transcript reconcile worker requires a task");
    }
    if (!(value.port instanceof MessagePort)) {
      throw new Error("session transcript reconcile worker requires valid task data");
    }
    const { input, port, coordination, sourceIdentity } =
      // SAFETY: The typed pool owns this private payload; phase admission is checked below.
      value as SessionTranscriptReconcileWorkerTask;
    try {
      if (
        !coordination?.reconciliation ||
        coordination.actorId !== `transcript:${input.mode}:${input.leaseId}` ||
        coordination.databasePath !== resolveOpenClawStateSqlitePath(resolveLeaseEnvironment(input))
      ) {
        throw new Error("Transcript worker shared-state owner changed");
      }
      await run(input, port, coordination, sourceIdentity);
    } finally {
      value.port.close();
    }
  },
  { retireOnError: true },
);
