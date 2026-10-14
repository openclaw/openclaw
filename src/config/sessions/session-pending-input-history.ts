import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  hasRegisteredSessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInput,
} from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { prepareSqliteScope } from "./session-accessor.sqlite-scope.js";
import { hasSessionActorEmptyPendingInputHistory } from "./session-actor-replica.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type {
  PendingInputCustodyCandidate,
  PendingInputHistoryGrant,
  PendingInputHistoryQuery,
  PendingInputHistoryReceipt,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import { projectSessionPendingInput } from "./session-pending-input-value.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import {
  settleSessionWorkerReceipt,
  type SessionWorkerReceiptAdmission,
} from "./session-worker-receipt.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type Scope = SessionAccessScope & { agentId: string; sessionId: string };

function owns(path: string, row: PendingInputCustodyCandidate, currentSessionId?: string) {
  return row.session_id === currentSessionId && hasRegisteredSessionPendingInputOwner(path, row);
}

function admitCustody(
  path: string,
  stage: "transaction" | "commit",
  facts: PendingInputHistoryGrant,
) {
  const protectedRows = facts.protected ? new Int32Array(facts.protected) : undefined;
  if (stage === "transaction" && protectedRows?.length !== facts.candidates.length) {
    throw new Error("Pending input history omitted its live custody response");
  }
  facts.candidates.forEach((row, index) => {
    const protectedInput = owns(path, row, facts.currentSessionId);
    if (protectedRows) {
      Atomics.store(protectedRows, index, protectedInput ? 1 : 0);
    } else if (protectedInput) {
      throw new Error("Pending input acquired live custody before interruption committed");
    }
  });
}

function applyReceipt(snapshot: PendingInputHistorySnapshot, receipt: PendingInputHistoryReceipt) {
  const interrupted = new Set(receipt.ids);
  for (const row of snapshot.rows) {
    if (interrupted.has(row.input_id)) {
      row.state = "interrupted";
    }
  }
  return snapshot;
}

async function readMemoryPendingInputHistory(
  binding: SessionActorStorageBinding,
  query: PendingInputHistoryQuery,
): Promise<PendingInputHistorySnapshot> {
  const storage = binding.actor.storage!;
  const snapshot = await storage.read(
    { type: "session.pendingInput.history", input: query },
    binding.authority,
  );
  const ids = snapshot.rows.filter((row) => row.state === "queued").map((row) => row.input_id);
  if (!ids.length) {
    return snapshot;
  }
  const outcome = await storage.mutate(
    {
      type: "session.pendingInput.interruptHistory",
      input: { sessionKey: query.sessionKey, sessionId: query.sessionId, ids },
    },
    {
      ...binding.authority,
      isPendingInputProtected: (candidate, currentSessionId) =>
        owns(binding.path, candidate, currentSessionId),
    },
  );
  if (outcome.kind === "rolled-back") {
    throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
  }
  if (outcome.failure) {
    throw Object.assign(new Error(outcome.failure.message), { name: outcome.failure.name });
  }
  return applyReceipt(snapshot, outcome.value);
}

async function readPendingInputRows(
  scope: Scope,
  options: Omit<PendingInputHistoryQuery, "sessionKey" | "sessionId">,
  onRead?: (snapshot: PendingInputHistorySnapshot) => void,
): Promise<PendingInputHistorySnapshot> {
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
          };
          if (onRead) {
            const snapshot = binding.actor.storage!.readCurrent(
              { type: "session.pendingInput.history", input: query },
              binding.authority,
            );
            onRead(snapshot);
            return snapshot;
          }
          return readMemoryPendingInputHistory(binding, query);
        },
      )) ?? { rows: [], total: 0 }
    );
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const query = { ...options, sessionKey: scope.sessionKey, sessionId: scope.sessionId };
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
    assertCurrent,
  } = target.resolve(resolved);
  if (!identity.key.startsWith("file:")) {
    return { rows: [], total: 0 };
  }
  assertReadCurrent();
  if (hasSessionActorEmptyPendingInputHistory(identity, resolved.sessionKey, query.sessionId)) {
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
          const snapshot = await owner.readPendingInputHistory({
            query: { ...query, sessionKey: resolved.sessionKey },
            env: captured.env,
            source: readSource,
          });
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
    const ids = snapshot.rows
      .filter(
        (row) =>
          row.state === "queued" && !owns(identity.canonicalPath, row, snapshot.currentSessionId),
      )
      .map((row) => row.input_id);
    if (!ids.length) {
      return snapshot;
    }
    let admitted: SessionWorkerReceiptAdmission | undefined;
    const checkCustody = (stage: "transaction" | "commit", facts: unknown) => {
      const publication = isRecord(facts) ? facts.publication : undefined;
      if (!isRecord(publication) || publication.kind !== "pending-input-history-custody") {
        throw new Error("Pending input history omitted custody facts");
      }
      // SAFETY: The paired bounded kernel owns these facts, never host authority.
      admitCustody(identity.canonicalPath, stage, publication as PendingInputHistoryGrant);
    };
    return withSessionEntryWorker(
      databaseOptions,
      readSource.databaseIdentity,
      () => {
        assertCurrent();
        owner.assertCurrent();
      },
      async (execution, source) => {
        const result = await execution.runExisting(source, (worker) =>
          settleSessionWorkerReceipt(
            () =>
              worker.execute({
                type: "session.pendingInputs.interruptHistory",
                input: { sessionKey: resolved.sessionKey, sessionId: captured.sessionId, ids },
              }),
            () => admitted,
            (receipt) => {
              if (isRecord(receipt) && receipt.kind === "pending-input-history-interrupted") {
                // SAFETY: This admission retains only this exact kernel's committed receipt.
                return applyReceipt(snapshot, receipt as PendingInputHistoryReceipt);
              }
              return undefined;
            },
            "Pending input history has no confirmed native completion and receipt",
          ),
        );
        assertCurrent();
        if (!result) {
          throw new Error("Pending input history lost its existing database");
        }
        return result;
      },
      (admission, retained, facts) => {
        checkCustody("commit", facts);
        admitted = { admission, retained };
      },
      undefined,
      undefined,
      undefined,
      (facts) => checkCustody("transaction", facts),
    );
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
