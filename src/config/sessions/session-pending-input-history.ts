import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  hasRegisteredSessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInput,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import type {
  PendingInputCustodyCandidate,
  PendingInputHistoryGrant,
  PendingInputHistoryQuery,
  PendingInputHistoryReceipt,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import { projectSessionPendingInput } from "./session-pending-input-value.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
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

/** Inactive until P7d. Accepted reconciliation retains its actor through native settlement. */
export function createIncognitoPendingInputHistoryReader(params: {
  actor: Pick<
    IncognitoAgentDatabaseExecution,
    "path" | "sessions" | "assertCurrent" | "assertReadable"
  >;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
}) {
  const { actor, authority } = params;
  actor.assertCurrent();
  authority.assertCurrent();
  const target = structuredClone(params.target);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    actor.assertCurrent();
    authority.assertCurrent();
    claim.assertCurrent();
  };
  const boundAuthority: IncognitoSessionAuthority = {
    assertCurrent,
    authorize: (stage, facts) => authority.authorize?.(stage, facts),
  };
  const readRows = (query: Omit<PendingInputHistoryQuery, "sessionKey" | "sessionId">) => {
    assertCurrent();
    const captured = { ...query };
    return actor.sessions.withSharedState(async () => {
      const snapshot = await actor.sessions.history(boundAuthority, {
        type: "session.history.pending-inputs",
        input: { ...target, query: captured },
      });
      assertCurrent();
      const ids = snapshot.rows
        .filter(
          (row) => row.state === "queued" && !owns(actor.path, row, snapshot.currentSessionId),
        )
        .map((row) => row.input_id);
      if (ids.length) {
        const receipt = await actor.sessions.interruptPendingInputHistory(
          // The worker checks this session generation in its transaction; its pending
          // host projection cannot authorize its own mutation.
          authority,
          { ...target, ids },
          (stage, facts) => admitCustody(actor.path, stage, facts),
        );
        applyReceipt(snapshot, receipt);
      }
      assertCurrent();
      claim.authorize(authority, "commit");
      assertCurrent();
      return snapshot;
    });
  };
  return {
    async list(
      options: { limit?: number; before?: number } = {},
    ): Promise<SessionPendingInputPage> {
      const { rows, total, nextBefore } = await readRows(options);
      assertCurrent();
      actor.assertReadable();
      return {
        items: rows.toReversed().map(projectSessionPendingInput),
        total: total ?? 0,
        ...(nextBefore !== undefined ? { nextBefore } : {}),
      };
    },
    async read(id: string): Promise<SessionPendingInput | undefined> {
      const row = (await readRows({ id, limit: 1 })).rows[0];
      assertCurrent();
      actor.assertReadable();
      return row ? projectSessionPendingInput(row) : undefined;
    },
  };
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

/** Incognito retains its process-held owner until the separate actor cutover (worker-access P7). */
async function readIncognito(scope: Scope, query: PendingInputHistoryQuery) {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const captured = getOpenClawAgentDatabaseIfOpen(options);
  if (!captured) {
    return { rows: [], total: 0 };
  }
  const { readPendingInputHistoryInDatabase } =
    await import("./session-pending-input-history.kernel.js");
  const { interruptPendingInputHistoryInDatabase } =
    await import("./session-pending-input-history-reconcile.js");
  if (getOpenClawAgentDatabaseIfOpen(options) !== captured || !captured.db.isOpen) {
    throw new Error("Pending input history lost its incognito database owner");
  }
  const capturedQuery = { ...query, sessionKey: resolved.sessionKey };
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => readPendingInputHistoryInDatabase(database, capturedQuery),
    options,
  );
  if (!read.found) {
    return { rows: [], total: 0 };
  }
  const snapshot = read.value;
  const path = resolveOpenClawAgentSqlitePath(options);
  const ids = snapshot.rows
    .filter((row) => row.state === "queued" && !owns(path, row, snapshot.currentSessionId))
    .map((row) => row.input_id);
  if (!ids.length) {
    return snapshot;
  }
  return applyReceipt(
    snapshot,
    interruptPendingInputHistoryInDatabase(
      openOpenClawAgentDatabase(options),
      options,
      { ...capturedQuery, ids },
      (stage, facts) => admitCustody(path, stage, facts),
      () => {},
    ),
  );
}

async function readPendingInputRows(
  scope: Scope,
  options: Omit<PendingInputHistoryQuery, "sessionKey" | "sessionId">,
): Promise<PendingInputHistorySnapshot> {
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    return readMemoryPendingInputHistory(memory, {
      ...options,
      sessionKey: memory.actor.target.sessionKey,
      sessionId: scope.sessionId,
    });
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const query = { ...options, sessionKey: scope.sessionKey, sessionId: scope.sessionId };
  if (isIncognitoSessionKey(captured.sessionKey)) {
    return readIncognito(captured, query);
  }
  const logical = resolveSqliteScope({ ...captured, storePath: undefined });
  const storePath =
    logical.path ??
    captured.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const resolved = await prepareSqliteScope(captured);
  const databaseOptions = toDatabaseOptions(resolved);
  const path = resolveOpenClawAgentSqlitePath(databaseOptions);
  const identity = identities.get(assertSessionStoreReadCandidate(path, candidates));
  if (!identity) {
    throw new Error("Pending input history changed its captured database owner");
  }
  if (!identity.key.startsWith("file:")) {
    return { rows: [], total: 0 };
  }
  const assertCurrent = () => {
    assertSessionStoreReadCandidate(path, candidates);
    assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
  };
  assertCurrent();
  const source = {
    agentId: databaseOptions.agentId,
    path,
    databaseIdentity: identity.key.slice(5),
    databaseBirthtime: identity.birthtime,
  };
  return withSessionHistoryWorkerDatabase({ ...databaseOptions, path }, async (owner) => {
    const snapshot = await owner.readPendingInputHistory({
      query: { ...query, sessionKey: resolved.sessionKey },
      env: captured.env,
      source,
    });
    assertCurrent();
    const ids = snapshot.rows
      .filter(
        (row) =>
          row.state === "queued" && !owns(identity.canonicalPath, row, snapshot.currentSessionId),
      )
      .map((row) => row.input_id);
    if (!ids.length) {
      return snapshot;
    }
    return runOpenClawAgentWorkerWrite({ ...databaseOptions, path }, async () => {
      assertCurrent();
      owner.assertCurrent();
      const execution = captureOpenClawAgentDatabaseExecution(
        { ...databaseOptions, path },
        {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: source.databaseIdentity,
            birthtime: identity.birthtime,
            nativeLocation: path,
          },
        },
      );
      let admitted:
        | {
            admission: SqliteWorkerOperationAdmission;
            retained: RetainedWorkerTransactionAdmission;
          }
        | undefined;
      try {
        const result = await execution.runExisting(
          {
            assertCurrent,
            createAdmission(binding) {
              return (retained) => {
                const admission = createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  assertCurrent();
                  owner.assertCurrent();
                  if (request.stage === "transaction" || request.stage === "commit") {
                    const facts = isRecord(request.facts) ? request.facts.publication : undefined;
                    if (!isRecord(facts) || facts.kind !== "pending-input-history-custody") {
                      throw new Error("Pending input history omitted custody facts");
                    }
                    admitCustody(
                      identity.canonicalPath,
                      request.stage,
                      // SAFETY: The paired bounded kernel owns this grant payload; it conveys facts, never authority.
                      facts as PendingInputHistoryGrant,
                    );
                    if (request.stage === "commit") {
                      admitted = { admission, retained };
                    }
                  }
                  if (!grant()) {
                    throw new Error("Pending input history authority expired");
                  }
                }, binding.attachment);
                return { nativeLocations: binding.nativeLocations, admission };
              };
            },
          },
          async (worker) => {
            const outcome = await worker
              .execute({
                type: "session.pendingInputs.interruptHistory",
                input: { sessionKey: resolved.sessionKey, sessionId: captured.sessionId, ids },
              })
              .then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            if (admitted) {
              await admitted.retained.settled;
              const receipt = admitted.admission.committed?.facts;
              if (
                admitted.admission.settlement?.kind === "completed" &&
                isRecord(receipt) &&
                receipt.kind === "pending-input-history-interrupted"
              ) {
                // SAFETY: This admission retains only this exact kernel's committed receipt.
                return applyReceipt(snapshot, receipt as PendingInputHistoryReceipt);
              }
            }
            if (!outcome.ok) {
              throw outcome.error;
            }
            throw new SqliteWorkerError(
              "Pending input history has no confirmed native completion and receipt",
              "outcome-unknown",
            );
          },
        );
        assertCurrent();
        if (!result) {
          throw new Error("Pending input history lost its existing database");
        }
        return result;
      } finally {
        await execution.release();
      }
    });
  });
}

export async function listSessionPendingInputs(
  scope: Scope,
  options: { limit?: number; before?: number } = {},
): Promise<SessionPendingInputPage> {
  const incognito = getSessionActorStorageBinding(scope)
    ? undefined
    : captureIncognitoSessionOperation(scope);
  if (incognito) {
    return createIncognitoPendingInputHistoryReader({
      ...incognito,
      target: {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        lifecycleRevision: incognito.actor.sessions.readSharing(scope.sessionKey)?.entry
          ?.lifecycleRevision,
      },
    }).list(options);
  }
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
): Promise<SessionPendingInput | undefined> {
  const incognito = getSessionActorStorageBinding(scope)
    ? undefined
    : captureIncognitoSessionOperation(scope);
  if (incognito) {
    return createIncognitoPendingInputHistoryReader({
      ...incognito,
      target: {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        lifecycleRevision: incognito.actor.sessions.readSharing(scope.sessionKey)?.entry
          ?.lifecycleRevision,
      },
    }).read(id);
  }
  const row = (await readPendingInputRows(scope, { id, limit: 1 })).rows[0];
  return row ? projectSessionPendingInput(row) : undefined;
}
