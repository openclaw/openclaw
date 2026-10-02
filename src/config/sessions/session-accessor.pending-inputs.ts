import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "../../chat/message-client-source.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  getAgentEventLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  preparePendingInputRequest,
  resolveCommittedPendingInputRequestHash,
  resolvePendingInputReplayRequest,
  matchesSessionPendingInputRequest,
  type PendingInputRequest,
} from "./session-accessor.pending-input-request.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  claimCurrentSessionPendingInputDedupeRecovery,
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
  readSessionPendingInputByKey,
  hasRegisteredSessionPendingInputOwner,
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  assertRegisteredSessionPendingInputOwner,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { preparePendingInputStore } from "./session-pending-input-store.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  completion?: AgentRunTerminalOutcome;
  complete?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome;
  completeAsync?: (outcome: AgentRunTerminalOutcome) => Promise<AgentRunTerminalOutcome>;
  settled?: () => Promise<void>;
};
const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();

function ownerReceipt(owner: SessionPendingInputOwner): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    get state() {
      return owner.consumed || owner.sources?.every((source) => source.consumed)
        ? "consumed"
        : "queued";
    },
    inputId: owner.inputId,
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    finish: owner.finish,
  };
  receiptOwners.set(receipt, owner);
  return receipt;
}

/** Install only a private receipt's persistence context; this does not reopen execution authority. */
export function withSessionPendingInputPersistence<T>(
  receipt: SessionPendingInputReceipt,
  persist: () => T,
): T {
  const owner = receiptOwners.get(receipt);
  return owner ? runWithSessionPendingInputPersistence(owner, persist) : receipt.run(persist);
}

/** Bind one collected message to its private admitted sources without creating another durable queue. */
export function bindSessionPendingInputSources(
  receipts: readonly SessionPendingInputReceipt[],
  message: PersistedUserTurnMessage,
): SessionPendingInputReceipt | undefined {
  const sources = [
    ...new Set(
      receipts.flatMap((receipt) => {
        if (receipt.state === "consumed") {
          throw new Error("Collected input has already been consumed");
        }
        const owner = receiptOwners.get(receipt);
        return owner ? (owner.sources ?? [owner]) : [];
      }),
    ),
  ];
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (
    !idempotencyKey ||
    sources.some(
      (source) =>
        source.workerDatabasePath !== first.workerDatabasePath ||
        source.sessionId !== first.sessionId ||
        source.sessionKey !== first.sessionKey ||
        source.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error("Collected input requires one exact session and a distinct aggregate identity");
  }
  // Collected framing still passes storage redaction; its staged sources have
  // already passed approval and must not run through another plugin hook.
  const clients = normalizeMessageClientSources(
    receipts.flatMap((receipt) => readMessageClientSources(receipt.message)),
  );
  const collectedMessage = { ...message };
  if (clients.length) {
    collectedMessage["__openclaw"] = {
      ...message["__openclaw"],
      transport: { ...asOptionalRecord(message["__openclaw"]?.transport), clients },
    };
  }
  const messageJson = JSON.stringify(
    redactTranscriptMessageForStorage(collectedMessage, { config: sources.at(-1)?.config }),
  );
  if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Collected input exceeds the Gateway payload limit");
  }
  const aggregateInputId = randomUUID();
  const aggregate = ownerReceipt({
    ...first,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: (disposition) => {
      const failures: unknown[] = [];
      for (const source of sources) {
        try {
          source.finish(disposition);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Failed to finish collected input custody");
      }
    },
  });
  aggregate.settled = async () => {
    const results = await Promise.allSettled(receipts.map(async (receipt) => receipt.settled?.()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length) {
      throw new AggregateError(failures, "Failed to settle collected input custody");
    }
  };
  return aggregate;
}

type PendingInputStageOptions = PendingInputRequest & {
  trackCompletion?: boolean;
  assertCurrent: () => void;
  assertAdmittedCurrent?: () => void;
  assertCompletionCurrent?: () => void;
};

/** Accept durable input without changing the active transcript or scheduling execution. */
export function stageSessionPendingInput(
  scope: PendingInputScope,
  options: PendingInputStageOptions,
): Promise<SessionPendingInputReceipt | undefined> {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const preparedRequest = preparePendingInputRequest(options);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const admission = resolveSqliteWriteAdmissionScope(captured);
  const stage = async () => {
    const store = await preparePendingInputStore(captured, options.assertCurrent);
    return store.withAdmission(
      () =>
        stagePreparedPendingInput(captured, options, preparedRequest, lifecycleGeneration, store),
      admission !== undefined,
    );
  };
  return admission ? runOpenClawAgentWriteAdmission(toDatabaseOptions(admission), stage) : stage();
}

async function stagePreparedPendingInput(
  scope: PendingInputScope,
  options: PendingInputStageOptions,
  preparedRequest: ReturnType<typeof preparePendingInputRequest>,
  lifecycleGeneration: string,
  store: Awaited<ReturnType<typeof preparePendingInputStore>>,
): Promise<SessionPendingInputReceipt | undefined> {
  let retained = false;
  let finished = false;
  let owner: SessionPendingInputOwner | undefined;
  let completion: Promise<AgentRunTerminalOutcome> | undefined;
  try {
    const identity = {
      sessionKey: store.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey: preparedRequest.idempotencyKey,
    };
    const snapshot = await store.read({
      ...identity,
      kind: "stage",
      trackCompletion: options.trackCompletion === true,
    });
    if (snapshot.kind !== "stage") {
      throw new Error("Pending input read returned a different operation");
    }
    options.assertCurrent();
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    if (!snapshot.current) {
      return undefined;
    }
    const { existing, previous, committed } = snapshot;
    const replayRequest = resolvePendingInputReplayRequest(preparedRequest, previous ?? existing);
    const { message, stableMessage } = replayRequest;
    let requestHash = replayRequest.requestHash;
    if (previous && (previous.request_hash !== requestHash || previous.run_id !== options.runId)) {
      throw new Error("Input completion idempotency key conflicts with the accepted input");
    }
    if (previous && isFinalInputCompletion(previous.outcome)) {
      return {
        state: "consumed",
        inputId: identity.idempotencyKey,
        message,
        completion: previous.outcome,
        run: () => {
          throw new Error("Input processing has already completed");
        },
        finish: () => {},
      };
    }
    const assertUnowned = (row = existing) => {
      if (row && hasRegisteredSessionPendingInputOwner(store.workerDatabasePath, row)) {
        throw new SessionPendingInputCustodyError(
          "Pending input is already admitted; wait for its current turn",
        );
      }
    };
    if (existing) {
      if (
        !matchesSessionPendingInputRequest(existing, stableMessage, requestHash) ||
        existing.run_id !== options.runId
      ) {
        throw new Error("Pending input idempotency key conflicts with the accepted input");
      }
      if (existing.consumed_event_id != null) {
        return {
          state: "consumed",
          inputId: existing.input_id,
          message: parseSessionPendingInputMessage(existing.message_json),
          run: () => {
            throw new Error("Pending input has already been consumed");
          },
          finish: () => {},
        };
      }
      assertUnowned();
      if (
        (!options.requestFingerprint && !options.trackCompletion) ||
        (existing.state !== "queued" && existing.state !== "interrupted") ||
        (existing.lifecycle_generation === lifecycleGeneration && !options.trackCompletion)
      ) {
        throw new Error("Pending input ownership ended; submit a new turn to continue");
      }
    }
    const settlementIdentity = () => ({
      ...identity,
      runId: options.runId,
      requestHash,
      lifecycleGeneration,
    });
    const assertCompletion = () => {
      (options.assertCompletionCurrent ?? options.assertCurrent)();
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      if (owner) {
        assertRegisteredSessionPendingInputOwner(owner);
      }
    };
    const completionInput = (outcome: AgentRunTerminalOutcome) => ({
      ...settlementIdentity(),
      kind: "complete" as const,
      outcome,
    });
    const complete = options.trackCompletion
      ? (outcome: AgentRunTerminalOutcome) => {
          if (finished || completion) {
            throw new Error("Input completion owner has already been released or is settling");
          }
          assertCompletion();
          return store.nativeMutation(completionInput(outcome), assertCompletion).outcome!;
        }
      : undefined;
    const completeAsync = options.trackCompletion
      ? (outcome: AgentRunTerminalOutcome) => {
          if (completion) {
            return completion;
          }
          if (finished) {
            return Promise.reject(new Error("Input completion owner has already been released"));
          }
          assertCompletion();
          completion = store.mutate(completionInput(outcome), assertCompletion).then((receipt) => {
            if (!receipt.outcome) {
              throw new Error("Input completion omitted its committed outcome");
            }
            return receipt.outcome;
          });
          return completion;
        }
      : undefined;
    const finish = (disposition: "cancelled" | "interrupted") => {
      if (finished) {
        return;
      }
      finished = true;
      if (owner) {
        owner.settling = true;
      }
      // Prompt authority ends now; history custody lasts through terminal settlement.
      const settleDisposition = async () => {
        if (owner && !owner.consumed) {
          await store.mutate(
            { ...settlementIdentity(), kind: "finish", inputId: owner.inputId, disposition },
            () => assertRegisteredSessionPendingInputOwner(owner!),
          );
        }
      };
      const ending = completion
        ? completion
            .catch((error: unknown) => {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
            })
            .then(settleDisposition)
        : settleDisposition();
      store.retire(
        ending.then(
          () => {
            if (owner) {
              releaseSessionPendingInputOwner(owner);
            }
          },
          (error: unknown) => {
            if (owner && !hasSqliteWorkerOutcomeUnknown(error)) {
              releaseSessionPendingInputOwner(owner);
            }
            throw error;
          },
        ),
      );
    };
    store.bindCustody(() => {
      finished = true;
      if (owner) {
        releaseSessionPendingInputOwner(owner);
      }
    });
    const completionMethods = {
      ...(complete ? { complete, completeAsync } : {}),
      settled: store.settled,
    };
    if (committed) {
      if (options.trackCompletion) {
        const committedHash = resolveCommittedPendingInputRequestHash(
          {
            ...options,
            message,
            replaySourceSessionKeys:
              previous || existing ? undefined : options.replaySourceSessionKeys,
          },
          committed.message,
        );
        if (!committedHash) {
          return undefined;
        }
        requestHash = committedHash;
        options.assertCurrent();
      }
      retained = true;
      return {
        state: "queued",
        inputId: committed.messageId,
        message: committed.message,
        run: (run) => {
          store.assertCurrent();
          if (finished) {
            throw new SessionPendingInputCustodyError("Pending input ownership ended");
          }
          options.assertCurrent();
          return run();
        },
        finish,
        ...completionMethods,
      };
    }
    const prepared = existing
      ? parseSessionPendingInputMessage(existing.message_json)
      : options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(message)
        : message;
    if (!prepared) {
      return undefined;
    }
    const messageJson =
      existing?.message_json ??
      JSON.stringify(redactTranscriptMessageForStorage(prepared, { config: options.config }));
    if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error("Approved pending input exceeds the Gateway payload limit");
    }
    const inputId = existing?.input_id ?? randomUUID();
    owner = {
      inputId,
      transcriptInputId: inputId,
      sessionId: scope.sessionId,
      sessionKey: store.sessionKey,
      databasePath: store.path,
      workerDatabasePath: store.workerDatabasePath,
      idempotencyKey: identity.idempotencyKey,
      lifecycleGeneration,
      messageJson,
      config: options.config,
      assertCurrent: options.assertAdmittedCurrent ?? options.assertCurrent,
      ...(existing ? { restartRecovered: true as const } : {}),
      finish,
    };
    await store.mutate(
      {
        ...settlementIdentity(),
        kind: "stage",
        expected: snapshot,
        trackCompletion: options.trackCompletion === true,
        inputId,
        messageJson,
      },
      (_stage, facts) => {
        options.assertCurrent();
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        assertUnowned(facts?.candidate);
      },
      () => {
        options.assertCurrent();
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        registerSessionPendingInputOwner(owner!);
      },
    );
    retained = true;
    return Object.assign(ownerReceipt(owner), completionMethods);
  } finally {
    if (!retained) {
      await store.release();
    }
  }
}

export {
  listSessionPendingInputs,
  readSessionPendingInput,
} from "./session-pending-input-history.js";

/** Verify source custody before replacing a stale process-local completed receipt. */
export function claimSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): boolean {
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => claimCurrentSessionPendingInputDedupeRecovery(database, resolved, runId),
    toDatabaseOptions(resolved),
  );
  return result.found && result.value;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): PersistedUserTurnMessage | undefined {
  try {
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const db = getSessionKysely(database.db);
          const session = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_nodes")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_nodes.current_session_id",
              )
              .select("current_session_id")
              .where("session_nodes.session_key", "=", resolved.sessionKey)
              .where("session_windows.session_key", "=", resolved.sessionKey),
          );
          if (session?.current_session_id !== resolved.sessionId) {
            return undefined;
          }
          // Collected sources survive consumption; their text is not the aggregate transcript.
          // Check byte metadata before either reader materializes stored JSON.
          const pending = hasSessionPendingInputsSchema(database.db)
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_pending_inputs")
                  .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", resolved.sessionId)
                  .where("idempotency_key", "=", idempotencyKey),
              )
            : undefined;
          let messageJson: string | undefined;
          if (pending) {
            if (pending.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            messageJson = readSessionPendingInputByKey(
              database,
              resolved,
              idempotencyKey,
            )?.message_json;
          } else {
            // Stale projections cannot establish retry identity. Their owning writer repairs them.
            if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
              return undefined;
            }
            const transcript = executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("transcript_event_identities as identity")
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "identity.session_id")
                    .onRef("event.seq", "=", "identity.seq"),
                )
                .select(transcriptEventReadBytesSql("event").as("bytes"))
                .where("identity.session_id", "=", resolved.sessionId)
                .where("identity.message_idempotency_key", "=", idempotencyKey)
                .orderBy("identity.seq", "desc")
                .limit(1),
            );
            if (!transcript || transcript.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            const committed = readTranscriptMessageByScopedIdempotencyKey(
              database,
              resolved,
              idempotencyKey,
              "scan",
            );
            messageJson = committed ? JSON.stringify(committed.message) : undefined;
          }
          if (!messageJson) {
            return undefined;
          }
          const message = parseSessionPendingInputMessage(messageJson);
          return readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
        }),
      toDatabaseOptions(resolved),
    );
    return result.found ? result.value : undefined;
  } catch {
    // Unavailable or corrupt storage supplies no proof of the original submitted bytes.
    return undefined;
  }
}
