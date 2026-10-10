import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { SessionPendingInputs } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type {
  SessionPendingInputAuthority,
  SessionPendingInputAuthorityFacts,
} from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { SessionPendingInputState } from "./session-pending-input-receipt.types.js";

export type SessionPendingInput = {
  id: string;
  runId: string;
  message: PersistedUserTurnMessage;
  acceptedAt: number;
  state: SessionPendingInputState;
};
export type SessionPendingInputPage = {
  items: SessionPendingInput[];
  total: number;
  nextBefore?: number;
};
export type SessionPendingInputRow = Selectable<SessionPendingInputs>;
type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export type SessionPendingInputOwner = {
  agentId?: string;
  databaseAgentId?: string;
  inputId: string;
  transcriptInputId: string;
  sessionId: string;
  sessionKey: string;
  /** Native cache locator; may be the process-held incognito sentinel. */
  databasePath: string;
  /** Captured physical locator, or native incognito locator, for comparisons and workers. */
  workerDatabasePath: string;
  idempotencyKey: string;
  lifecycleGeneration: string;
  messageJson: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  authority?: SessionPendingInputAuthority;
  /** Published only after the exact input was consumed by a committed transcript write. */
  consumed?: true;
  /** Prompt authority is revoked; this owner still holds terminal disposition custody. */
  settling?: true;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  restartRecovered?: true;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
};

/** Transported facts do not grant custody; the host retains and checks the exact live owner. */
export type SessionPendingInputWorkerFacts = Pick<
  SessionPendingInputOwner,
  | "inputId"
  | "agentId"
  | "databaseAgentId"
  | "transcriptInputId"
  | "sessionId"
  | "sessionKey"
  | "databasePath"
  | "idempotencyKey"
  | "lifecycleGeneration"
  | "messageJson"
> & { preparedAuthority?: true; sources?: readonly SessionPendingInputWorkerFacts[] };

export type SessionPendingInputWorkerReceipt = {
  transcriptInputId: string;
  consumedInputIds: string[];
};

const workerCustody = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPendingInputWorkerCustody"),
  () =>
    new AsyncLocalStorage<{
      owner: SessionPendingInputOwner;
      assertCurrent(): void;
      consumed: Set<string>;
    }>(),
);

export function captureSessionPendingInputWorkerCustody() {
  const owner = owners.current.getStore();
  if (!owner) {
    return undefined;
  }
  const copy = (current: SessionPendingInputOwner): SessionPendingInputWorkerFacts => ({
    agentId: current.agentId,
    databaseAgentId: current.databaseAgentId,
    inputId: current.inputId,
    transcriptInputId: current.transcriptInputId,
    sessionId: current.sessionId,
    sessionKey: current.sessionKey,
    databasePath: current.workerDatabasePath,
    idempotencyKey: current.idempotencyKey,
    lifecycleGeneration: current.lifecycleGeneration,
    messageJson: current.messageJson,
    preparedAuthority:
      current.authority || current.sources?.some((source) => source.authority) ? true : undefined,
    ...(current.sources ? { sources: current.sources.map(copy) } : {}),
  });
  const relocation = owners.relocation.getStore();
  return {
    facts: copy(owner),
    ...(relocation?.owner === owner ? { relocation: relocation.sourceInputId } : {}),
    assertCurrent: (facts?: SessionPendingInputAuthorityFacts, assertSourceCurrent?: () => void) =>
      assertPendingInputOwnerCurrent(owner, facts, assertSourceCurrent),
    publish(receipt: SessionPendingInputWorkerReceipt) {
      owner.transcriptInputId = receipt.transcriptInputId;
      const consumed = new Set(receipt.consumedInputIds);
      for (const source of owner.sources ?? [owner]) {
        if (consumed.has(source.inputId)) {
          source.consumed = true;
        }
      }
    },
  };
}

/** Runs inside the writer; every live check crosses back to the captured host admission. */
export function runWithSessionPendingInputWorkerCustody<T>(
  facts: SessionPendingInputWorkerFacts,
  relocation: string | undefined,
  assertCurrent: () => void,
  run: () => T,
): { value: T; receipt: SessionPendingInputWorkerReceipt } {
  const hydrate = (current: SessionPendingInputWorkerFacts): SessionPendingInputOwner => ({
    ...current,
    workerDatabasePath: current.databasePath,
    sources: current.sources?.map(hydrate),
    assertCurrent,
    finish: () => {
      throw new Error("Worker custody cannot finish its host owner");
    },
  });
  const owner = hydrate(facts);
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
  current: new AsyncLocalStorage<SessionPendingInputOwner>(),
  relocation: new AsyncLocalStorage<{
    owner: SessionPendingInputOwner;
    sourceInputId: string;
  }>(),
  transactionRelocations: new WeakMap<DatabaseSync, Map<SessionPendingInputOwner, string>>(),
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

export function runWithSessionPendingInput<T>(owner: SessionPendingInputOwner, run: () => T): T {
  assertPendingInputOwnerCurrent(owner);
  return owners.current.run(owner, run);
}

/** Persistence alone may mirror a closed turn; the append owner proves exact committed bytes. */
export function runWithSessionPendingInputPersistence<T>(
  owner: SessionPendingInputOwner,
  persist: () => T,
): T {
  return owners.current.run(owner, persist);
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
  row: Pick<
    SessionPendingInputRow,
    "input_id" | "session_key" | "session_id" | "lifecycle_generation"
  >,
): boolean {
  const owner = owners.live.get(row.input_id);
  return (
    owner?.workerDatabasePath === databasePath &&
    owner.sessionId === row.session_id &&
    owner.sessionKey === row.session_key &&
    owner.lifecycleGeneration === row.lifecycle_generation &&
    (owner.settling || isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration))
  );
}

export function parseSessionPendingInputMessage(messageJson: string): PersistedUserTurnMessage {
  const value: unknown = JSON.parse(messageJson);
  if (asOptionalRecord(value)?.role !== "user") {
    throw new Error("Pending input has an invalid persisted user message");
  }
  // SAFETY: only typed admission writes this JSON; parsing preserves its canonical message shape.
  return value as PersistedUserTurnMessage;
}

export function isFinalInputCompletion(outcome: AgentRunTerminalOutcome): boolean {
  return (
    outcome.reason === "completed" ||
    (outcome.reason === "cancelled" && outcome.stopReason !== "restart")
  );
}

type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_input_completions")
      .selectAll()
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("idempotency_key", "=", scope.idempotencyKey),
  );
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
        outcome_json: JSON.stringify(outcome),
        succeeded: succeeded ? 1 : 0,
        completed_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet({
            outcome_json: JSON.stringify(outcome),
            succeeded: succeeded ? 1 : 0,
            completed_at: Date.now(),
          })
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
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
        .where("lifecycle_generation", "=", scope.lifecycleGeneration),
    );
  }
  return outcome;
}

export function projectSessionPendingInput(row: SessionPendingInputRow): SessionPendingInput {
  if (row.state !== "queued" && row.state !== "interrupted" && row.state !== "cancelled") {
    throw new Error("Pending input has an invalid disposition");
  }
  return {
    id: row.input_id,
    runId: row.run_id,
    message: parseSessionPendingInputMessage(row.message_json),
    acceptedAt: row.accepted_at,
    state: row.state,
  };
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

export type SessionPendingInputAppend = {
  inputId: string;
  message: PersistedUserTurnMessage;
  alreadyPromoted: boolean;
  sourceInputIds?: readonly string[];
  stageRelocation?: (destinationInputId: string) => void;
};

/** The private call-path owner, not a copied id or durable row, permits promotion. */
export function resolveSessionPendingInputAppend(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
): SessionPendingInputAppend | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user" || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const idempotencyKey = record.idempotencyKey.trim();
  const row = readSessionPendingInputByKey(database, scope, idempotencyKey);
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
            !stageSqliteTransactionState(database.db, {
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
    const acceptedByKey = new Map(
      executeSqliteQuerySync(
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
      ).rows.map((sourceRow) => [sourceRow.idempotency_key, sourceRow]),
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
  // Outer commit publishes this fact before observers; rollback leaves finish responsible.
  const worker = workerCustody.getStore();
  const newlyConsumed = consumedOwners.filter(
    (candidate) => !worker?.consumed.has(candidate.inputId),
  );
  stageSqliteTransactionState(database.db, {
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
    commit: () => {
      for (const consumedOwner of consumedOwners) {
        consumedOwner.consumed = true;
      }
    },
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
