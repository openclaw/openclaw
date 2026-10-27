import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { AsyncContext } from "../../shared/async-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { MAX_SESSION_ACTOR_COMPLETIONS } from "./session-actor-hydration.types.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import {
  readSessionActorTransactionState,
  writableSessionActorMap,
} from "./session-actor-transaction.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import {
  collectForeignLiveSessionPendingInputEntries,
  copySessionPendingInputWorkerFacts,
  hydratePendingInputWorkerOwner,
  publishConsumedSessionPendingInputSources,
  publishSessionPendingInputWorkerReceipt,
} from "./session-pending-input-live-owner.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
} from "./session-pending-input-value.js";
import type {
  SessionPendingInputRow,
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
  SessionPendingInputAppend,
  SessionInputCompletion,
} from "./session-pending-input.types.js";

type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export type {
  SessionPendingInput,
  SessionPendingInputPage,
  SessionPendingInputRow,
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
  SessionPendingInputAppend,
} from "./session-pending-input.types.js";

const workerCustody = new AsyncContext<{
  owner: SessionPendingInputOwner;
  assertCurrent(): void;
  consumed: Set<string>;
}>(Symbol.for("openclaw.sessionPendingInputWorkerCustody"));

export function captureSessionPendingInputWorkerCustody() {
  const owner = owners.current.getStore();
  if (!owner) {
    return undefined;
  }
  const relocation = owners.relocation.getStore();
  return {
    facts: copySessionPendingInputWorkerFacts(owner),
    ...(relocation?.owner === owner ? { relocation: relocation.sourceInputId } : {}),
    assertCurrent: (facts?: SessionPendingInputAuthorityFacts, assertSourceCurrent?: () => void) =>
      assertPendingInputOwnerCurrent(owner, facts, assertSourceCurrent),
    publish: (receipt: SessionPendingInputWorkerReceipt) =>
      publishSessionPendingInputWorkerReceipt(owner, receipt),
  };
}

/** Runs inside the writer; every live check crosses back to the captured host admission. */
export function runWithSessionPendingInputWorkerCustody<T>(
  facts: SessionPendingInputWorkerFacts,
  relocation: string | undefined,
  assertCurrent: () => void,
  run: () => T,
): { value: T; receipt: SessionPendingInputWorkerReceipt } {
  const owner = hydratePendingInputWorkerOwner(facts, assertCurrent);
  const value = workerCustody.run({ owner, assertCurrent, consumed: new Set() }, () =>
    owners.current.run(owner, () =>
      relocation === undefined
        ? run()
        : owners.relocation.run({ owner, sourceInputId: relocation }, run),
    ),
  );
  return {
    value,
    receipt: {
      transcriptInputId: owner.transcriptInputId,
      consumedInputIds: (owner.sources ?? [owner])
        .filter((source) => source.consumed)
        .map((source) => source.inputId),
    },
  };
}

/** Provisional worker facts; only the matching outer COMMIT may publish them on the host. */
export function readSessionPendingInputWorkerReceipt(
  database: PendingInputDatabase,
): SessionPendingInputWorkerReceipt | undefined {
  const custody = workerCustody.getStore();
  if (!custody) {
    return undefined;
  }
  return {
    transcriptInputId:
      owners.transactionRelocations.get(database.db)?.get(custody.owner) ??
      custody.owner.transcriptInputId,
    consumedInputIds: [...custody.consumed],
  };
}

const owners = resolveGlobalSingleton(Symbol.for("openclaw.sessionPendingInputOwners"), () => ({
  live: new Map<string, SessionPendingInputOwner>(),
  current: new AsyncContext<SessionPendingInputOwner>(
    Symbol.for("openclaw.sessionPendingInputOwners.current"),
  ),
  relocation: new AsyncContext<{
    owner: SessionPendingInputOwner;
    sourceInputId: string;
  }>(Symbol.for("openclaw.sessionPendingInputOwners.relocation")),
  transactionRelocations: new WeakMap<EngineConnection, Map<SessionPendingInputOwner, string>>(),
}));

const recoveredDedupeOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPendingInputDedupeRecoveries"),
  () => new WeakSet<SessionPendingInputOwner>(),
);

registerAgentEventLifecycleRotationHandler("session-pending-inputs", () => {
  const failures: unknown[] = [];
  for (const owner of owners.live.values()) {
    try {
      owner.finish("interrupted");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to record interrupted pending inputs");
  }
});

export function registerSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.has(owner.inputId)) {
    throw new Error("Pending input already has a live owner");
  }
  owners.live.set(owner.inputId, owner);
}

export function releaseSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.get(owner.inputId) === owner) {
    owners.live.delete(owner.inputId);
  }
  // Timers can retain this owner through their async frame after settlement.
  // Keep replay facts, but release the admission and staging closures.
  owner.assertCurrent = assertPendingInputOwnerActive.bind(undefined, owner);
  owner.assertMentionInvitationCurrent = undefined;
  owner.finish = () => {};
  owner.authority = undefined;
  owner.promotedOwner = undefined;
}

export function assertRegisteredSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.get(owner.inputId) !== owner) {
    throw new SessionPendingInputCustodyError("Pending input settlement lost its registered owner");
  }
}

function assertPendingInputOwnerActive(owner: SessionPendingInputOwner): void {
  if (
    owners.live.get(owner.inputId) !== owner ||
    owner.settling ||
    !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input ownership ended; submit a new turn to continue",
    );
  }
}

function assertPendingInputOwnerCurrent(
  owner: SessionPendingInputOwner,
  facts?: SessionPendingInputAuthorityFacts,
  assertSourceCurrent?: () => void,
): void {
  const worker = workerCustody.getStore();
  if (worker?.owner === owner) {
    worker.assertCurrent();
    return;
  }
  if (owner.sources) {
    for (const source of owner.sources) {
      assertPendingInputOwnerCurrent(source, facts, assertSourceCurrent);
    }
    return;
  }
  assertPendingInputOwnerActive(owner);
  if (owner.authority && assertSourceCurrent) {
    if (!facts) {
      throw new Error("Pending input worker omitted current session authority");
    }
    owner.authority.withPreparedCurrent(facts, owner.assertCurrent, assertSourceCurrent);
  } else {
    owner.assertCurrent();
  }
  if (!owner.consumed) {
    owner.assertMentionInvitationCurrent?.();
  }
}

export function assertSessionPendingInputLifetimeCurrent(owner: SessionPendingInputOwner): void {
  if (owner.sources) {
    for (const source of owner.sources) {
      assertSessionPendingInputLifetimeCurrent(source);
    }
    return;
  }
  assertPendingInputOwnerActive(owner);
  (owner.authority?.assertLifetimeCurrent ?? owner.assertCurrent)();
}

/** Capture the calling owner before physical database discovery yields. */
export function captureForeignLiveSessionPendingInputReader() {
  const currentOwner = owners.current.getStore();
  return (scope: { databasePath: string; sessionId: string; sessionKey: string }) =>
    collectForeignLiveSessionPendingInputEntries({
      scope,
      liveOwners: owners.live.values(),
      currentOwner,
      assertLifetimeCurrent: assertSessionPendingInputLifetimeCurrent,
    });
}

export function runWithSessionPendingInput<T>(owner: SessionPendingInputOwner, run: () => T): T {
  const enter = () => {
    assertPendingInputOwnerCurrent(owner);
    return owners.current.run(owner, run);
  };
  return owner.sessionActor ? runWithSessionActorStorage(owner.sessionActor, enter) : enter();
}

/** Persistence alone may mirror a closed turn; the append owner proves exact committed bytes. */
export function runWithSessionPendingInputPersistence<T>(
  owner: SessionPendingInputOwner,
  persist: () => T,
): T {
  const enter = () => owners.current.run(owner, persist);
  return owner.sessionActor ? runWithSessionActorStorage(owner.sessionActor, enter) : enter();
}

/** A transcript rewrite may move only the exact current user owned by the live admitted turn. */
export function withSessionPendingInputRelocation<T>(
  sourceInputId: string,
  message: unknown,
  append: () => T,
): T {
  const owner = owners.current.getStore();
  const record = asOptionalRecord(message);
  const ownsSource = owner?.transcriptInputId === sourceInputId;
  const claimsOwner = record?.role === "user" && record.idempotencyKey === owner?.idempotencyKey;
  if (!owner || (!ownsSource && !claimsOwner)) {
    return append();
  }
  assertPendingInputOwnerCurrent(owner);
  if (JSON.stringify(message) !== owner.messageJson) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  return owners.relocation.run({ owner, sourceInputId }, append);
}

/** Registration owns disposition even after operational cancellation; this check performs no SQL. */
export function hasRegisteredSessionPendingInputOwner(
  databasePath: string,
  // Display reconciliation may hold an older page from before this exact input was recovered.
  row: Pick<SessionPendingInputRow, "input_id" | "session_key" | "session_id"> &
    Partial<Pick<SessionPendingInputRow, "lifecycle_generation">>,
): boolean {
  const owner = owners.live.get(row.input_id);
  return (
    owner?.workerDatabasePath === databasePath &&
    owner.sessionId === row.session_id &&
    owner.sessionKey === row.session_key &&
    (row.lifecycle_generation === undefined ||
      owner.lifecycleGeneration === row.lifecycle_generation) &&
    (owner.settling || isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration))
  );
}

type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
): SessionInputCompletion | undefined {
  const actor = readSessionActorTransactionState(database, scope);
  let row = actor?.completions.get(scope.idempotencyKey);
  if (!row && !actor?.completionsComplete) {
    row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_input_completions")
        .selectAll()
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey),
    );
  }
  if (!row) {
    return undefined;
  }
  // SAFETY: only writeSessionInputCompletion writes this feature-owned table with typed terminal outcomes.
  const outcome = JSON.parse(row.outcome_json) as AgentRunTerminalOutcome;
  return { ...row, outcome };
}

/** The caller holds the write transaction and has revalidated the exact live admission owner. */
export function writeSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope & {
    runId: string;
    requestHash: string;
    lifecycleGeneration: string;
  },
  outcome: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const retained = readSessionInputCompletion(database, scope);
  if (
    retained &&
    (retained.run_id !== scope.runId || retained.request_hash !== scope.requestHash)
  ) {
    throw new SessionPendingInputCustodyError("Input completion conflicts with the accepted input");
  }
  if (retained && isFinalInputCompletion(retained.outcome)) {
    return retained.outcome;
  }
  const succeeded = classifyAgentRunTerminalOutcome(outcome) === "success";
  const completedAt = Date.now();
  const completionState = {
    outcome_json: JSON.stringify(outcome),
    succeeded: succeeded ? 1 : 0,
    completed_at: completedAt,
  };
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values({
        session_key: scope.sessionKey,
        session_id: scope.sessionId,
        idempotency_key: scope.idempotencyKey,
        run_id: scope.runId,
        request_hash: scope.requestHash,
        ...completionState,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet(completionState)
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
  const actor = readSessionActorTransactionState(database, scope);
  if (actor && (!retained || retained.succeeded === 0)) {
    actor.completions = writableSessionActorMap(actor.completions);
    actor.completions.set(scope.idempotencyKey, {
      session_key: scope.sessionKey,
      session_id: scope.sessionId,
      idempotency_key: scope.idempotencyKey,
      run_id: retained?.run_id ?? scope.runId,
      request_hash: retained?.request_hash ?? scope.requestHash,
      ...completionState,
    });
    if (actor.completions.size > MAX_SESSION_ACTOR_COMPLETIONS) {
      actor.completions.delete(actor.completions.keys().next().value!);
      actor.completionsComplete = false;
    }
  }
  if (isFinalInputCompletion(outcome)) {
    // Handled hooks can finish without appending a user message. The completion
    // receipt retires that exact custody atomically in the caller's transaction.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey)
        .where("run_id", "=", scope.runId)
        .where("request_hash", "=", scope.requestHash)
        .where("lifecycle_generation", "=", scope.lifecycleGeneration)
        .where("consumed_event_id", "is", null),
    );
    const pending = actor?.pendingInputs.get(scope.idempotencyKey);
    if (
      pending &&
      pending.run_id === scope.runId &&
      pending.request_hash === scope.requestHash &&
      pending.lifecycle_generation === scope.lifecycleGeneration &&
      pending.consumed_event_id === null
    ) {
      if (actor) {
        actor.pendingInputs = writableSessionActorMap(actor.pendingInputs);
        actor.pendingInputs.delete(scope.idempotencyKey);
      }
    }
  }
  return outcome;
}

/** Capture the exact host owner before reading; claim it once in the consuming frame. */
export function prepareCurrentSessionPendingInputDedupeRecovery(
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  runId: string,
) {
  const owner = owners.current.getStore();
  if (
    !owner ||
    owner.sources ||
    owner.restartRecovered !== true ||
    recoveredDedupeOwners.has(owner) ||
    owner.sessionId !== scope.sessionId ||
    owner.sessionKey !== scope.sessionKey ||
    owner.idempotencyKey !== `${runId}:user`
  ) {
    return undefined;
  }
  // Preparation does not spend replay custody; the claim rechecks current authority.
  assertSessionPendingInputLifetimeCurrent(owner);
  return (
    path: string,
    snapshot: { current: boolean; pending?: SessionPendingInputRow },
  ): boolean => {
    assertPendingInputOwnerCurrent(owner);
    const row = snapshot.pending;
    if (
      owners.current.getStore() !== owner ||
      recoveredDedupeOwners.has(owner) ||
      owner.consumed ||
      owner.workerDatabasePath !== path ||
      !snapshot.current ||
      !row ||
      row.input_id !== owner.inputId ||
      row.run_id !== runId ||
      row.session_key !== owner.sessionKey ||
      row.session_id !== owner.sessionId ||
      row.lifecycle_generation !== owner.lifecycleGeneration ||
      row.message_json !== owner.messageJson ||
      row.state !== "queued" ||
      row.consumed_event_id != null ||
      !hasRegisteredSessionPendingInputOwner(path, row)
    ) {
      return false;
    }
    recoveredDedupeOwners.add(owner);
    return true;
  };
}

/** Query only the exact physical transcript; copied keys cannot adopt another generation. */
export function readSessionPendingInputByKey(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  idempotencyKey: string,
): SessionPendingInputRow | undefined {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor) {
    const row = actor.pendingInputs.get(idempotencyKey);
    return row && { ...row };
  }
  if (!hasSessionPendingInputsSchema(database.db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_id", "=", scope.sessionId)
      .where("session_key", "=", scope.sessionKey)
      .where("idempotency_key", "=", idempotencyKey),
  );
}

/** The private call-path owner, not a copied id or durable row, permits promotion. */
export function resolveSessionPendingInputAppend(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
  preparedInputs?: ReadonlyMap<string, SessionPendingInputRow>,
): SessionPendingInputAppend | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user" || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const idempotencyKey = record.idempotencyKey.trim();
  const row = preparedInputs
    ? preparedInputs.get(idempotencyKey)
    : readSessionPendingInputByKey(database, scope, idempotencyKey);
  const owner = owners.current.getStore();
  // A bound-session mirror shares source correlation, never its pending custody.
  const ownsInput =
    owner?.idempotencyKey === idempotencyKey &&
    owner.workerDatabasePath ===
      (readOpenClawAgentDatabaseIdentity(database).canonicalPath || database.path) &&
    owner.sessionId === scope.sessionId &&
    owner.sessionKey === scope.sessionKey;
  if (!row && !ownsInput) {
    return undefined;
  }
  if (
    !owner ||
    !ownsInput ||
    (row &&
      (row.input_id !== owner.inputId ||
        row.consumed_event_id != null ||
        row.state !== "queued" ||
        row.lifecycle_generation !== owner.lifecycleGeneration))
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input cannot be appended outside its admitted turn",
    );
  }
  const relocation = owners.relocation.getStore();
  const transactionRelocations = owners.transactionRelocations.get(database.db);
  const transcriptInputId = transactionRelocations?.get(owner) ?? owner.transcriptInputId;
  if (relocation?.owner === owner && relocation.sourceInputId !== transcriptInputId) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  const stageRelocation =
    relocation?.owner === owner
      ? (destinationInputId: string) => {
          let staged = owners.transactionRelocations.get(database.db);
          const hadPrevious = staged?.has(owner) ?? false;
          const previous = staged?.get(owner);
          if (
            !stageSqliteTransactionState(sqlPublicationAnchor(database.db), {
              stage: () => {
                staged ??= new Map();
                owners.transactionRelocations.set(database.db, staged);
                staged.set(owner, destinationInputId);
              },
              rollback: () => {
                if (hadPrevious && previous !== undefined) {
                  staged?.set(owner, previous);
                } else {
                  staged?.delete(owner);
                }
                if (staged?.size === 0) {
                  owners.transactionRelocations.delete(database.db);
                }
              },
              commit: () => {
                owner.transcriptInputId = destinationInputId;
                if (staged?.get(owner) === destinationInputId) {
                  staged.delete(owner);
                }
                if (staged?.size === 0) {
                  owners.transactionRelocations.delete(database.db);
                }
              },
            })
          ) {
            throw new Error("Pending input relocation requires a transcript write transaction");
          }
        }
      : undefined;
  if (owner.sources) {
    const inputs =
      preparedInputs ?? readSessionActorTransactionState(database, scope)?.pendingInputs;
    const acceptedByKey = new Map(
      (inputs
        ? owner.sources.flatMap((source) => inputs.get(source.idempotencyKey) ?? [])
        : executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_pending_inputs")
              .selectAll()
              .where("session_id", "=", scope.sessionId)
              .where("session_key", "=", scope.sessionKey)
              .where(
                "idempotency_key",
                "in",
                owner.sources.map((source) => source.idempotencyKey),
              ),
          ).rows
      ).map((sourceRow) => [sourceRow.idempotency_key, sourceRow]),
    );
    const sources = owner.sources.map((source) => {
      const accepted = acceptedByKey.get(source.idempotencyKey);
      if (
        !accepted ||
        accepted.input_id !== source.inputId ||
        accepted.lifecycle_generation !== source.lifecycleGeneration ||
        accepted.message_json !== source.messageJson
      ) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody changed before transcript promotion",
        );
      }
      return accepted;
    });
    const alreadyPromoted = sources.every((source) => source.consumed_event_id === owner.inputId);
    if (!alreadyPromoted) {
      if (sources.some((source) => source.consumed_event_id != null || source.state !== "queued")) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody ended before transcript promotion",
        );
      }
      assertPendingInputOwnerCurrent(owner);
    }
    return {
      inputId: transcriptInputId,
      message: parseSessionPendingInputMessage(owner.messageJson),
      alreadyPromoted,
      ...(!alreadyPromoted
        ? {
            mentionInvitations: owner.sources.flatMap((source) =>
              source.mentionInvitation ? [source.mentionInvitation] : [],
            ),
          }
        : {}),
      sourceInputIds: sources.map((source) => source.input_id),
      ...(alreadyPromoted && stageRelocation ? { stageRelocation } : {}),
    };
  }
  // Terminal mirroring may replay a consumed input after cancellation. The caller
  // must prove the existing message; this never permits a new append.
  if (row) {
    assertPendingInputOwnerCurrent(owner);
  }
  return {
    inputId: transcriptInputId,
    message: parseSessionPendingInputMessage(row?.message_json ?? owner.messageJson),
    alreadyPromoted: !row,
    ...(row && owner.mentionInvitation ? { mentionInvitations: [owner.mentionInvitation] } : {}),
    ...(!row && stageRelocation ? { stageRelocation } : {}),
  };
}

export function consumeSessionPendingInput(
  database: PendingInputDatabase,
  pending: SessionPendingInputAppend,
): void {
  if (pending.alreadyPromoted) {
    return;
  }
  const owner = owners.current.getStore();
  const inputIds = new Set(pending.sourceInputIds ?? [pending.inputId]);
  const databasePath = readOpenClawAgentDatabaseIdentity(database).canonicalPath || database.path;
  const consumedOwners = (owner?.sources ?? (owner ? [owner] : [])).filter(
    (candidate) =>
      (owners.live.get(candidate.inputId) === candidate ||
        workerCustody.getStore()?.owner === owner) &&
      candidate.workerDatabasePath === databasePath &&
      inputIds.has(candidate.inputId),
  );
  if (pending.sourceInputIds) {
    const updated = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ consumed_event_id: pending.inputId })
        .where("input_id", "in", [...pending.sourceInputIds])
        .where("state", "=", "queued")
        .where("consumed_event_id", "is", null),
    );
    if (updated.numAffectedRows !== BigInt(pending.sourceInputIds.length)) {
      throw new SessionPendingInputCustodyError(
        "Collected input custody changed during transcript promotion",
      );
    }
  } else {
    const deleted = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("input_id", "=", pending.inputId)
        .where("state", "=", "queued"),
    );
    if (deleted.numAffectedRows !== 1n) {
      return;
    }
  }
  const actor = readSessionActorTransactionState(database);
  if (actor) {
    for (const [key, row] of actor.pendingInputs) {
      if (!inputIds.has(row.input_id)) {
        continue;
      }
      actor.pendingInputs = writableSessionActorMap(actor.pendingInputs);
      if (pending.sourceInputIds) {
        actor.pendingInputs.set(key, { ...row, consumed_event_id: pending.inputId });
      } else {
        actor.pendingInputs.delete(key);
      }
    }
  }
  // Outer commit publishes this fact before observers; rollback leaves finish responsible.
  const worker = workerCustody.getStore();
  const newlyConsumed = consumedOwners.filter(
    (candidate) => !worker?.consumed.has(candidate.inputId),
  );
  stageSqliteTransactionState(sqlPublicationAnchor(database.db), {
    stage: () => {
      for (const consumedOwner of newlyConsumed) {
        worker?.consumed.add(consumedOwner.inputId);
      }
    },
    rollback: () => {
      for (const consumedOwner of newlyConsumed) {
        worker?.consumed.delete(consumedOwner.inputId);
      }
    },
    commit: () => publishConsumedSessionPendingInputSources(owner, consumedOwners),
  });
}

/** Logical deletion also clears custody when transcript windows are retained. */
export function deleteSessionPendingInputs(
  database: PendingInputDatabase,
  sessionKey: string,
): void {
  if (hasSessionPendingInputsSchema(database.db)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", sessionKey),
    );
  }
}
