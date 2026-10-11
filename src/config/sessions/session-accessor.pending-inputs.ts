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
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  preparePendingInputRequest,
  resolveCommittedPendingInputRequestHash,
  resolvePendingInputReplayRequest,
  matchesSessionPendingInputRequest,
  type PendingInputRequest,
} from "./session-accessor.pending-input-request.js";
import {
  prepareCurrentSessionPendingInputDedupeRecovery,
  hasRegisteredSessionPendingInputOwner,
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  assertRegisteredSessionPendingInputOwner,
  assertSessionPendingInputLifetimeCurrent,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteSessionKey,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { sanitizeTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import { getSessionInputActor } from "./session-input-actor.js";
import {
  withCurrentPendingInputAuthority,
  type SessionPendingInputAuthority,
} from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { PendingInputCustodyGrant } from "./session-pending-input-operations.types.js";
import type { SessionPendingInputReceipt } from "./session-pending-input-receipt.types.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import { preparePendingInputStore, type PendingInputScope } from "./session-pending-input-store.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
} from "./session-pending-input-value.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
export type { SessionPendingInputReceipt } from "./session-pending-input-receipt.types.js";

const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();
const withdrawnOwners = new WeakSet<SessionPendingInputOwner>();

export function readWithdrawnSessionPendingInputId(
  receipt: SessionPendingInputReceipt | undefined,
): string | undefined {
  const owner = receipt && receiptOwners.get(receipt);
  return owner && withdrawnOwners.has(owner) ? owner.inputId : undefined;
}

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
    runAsync: (operation) =>
      withCurrentPendingInputAuthority(
        (owner.sources ?? [owner]).flatMap((source) =>
          source.authority ? [source.authority] : [],
        ),
        () => assertSessionPendingInputLifetimeCurrent(owner),
        () => runWithSessionPendingInput(owner, operation),
      ),
    assertLifetimeCurrent: () => assertSessionPendingInputLifetimeCurrent(owner),
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
  const messageJson = JSON.stringify(sanitizeTranscriptMessageForStorage(collectedMessage));
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
  onCommitted?: (receipt: SessionPendingInputReceipt) => void;
  authority?: SessionPendingInputAuthority;
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
  const incognito = scope.incognito ?? captureIncognitoSessionOperation(scope);
  incognito?.admissionSignal?.throwIfAborted();
  incognito?.actor.assertCurrent();
  const captured = {
    ...scope,
    incognito: incognito && { ...incognito },
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const preparedRequest = preparePendingInputRequest(options);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  return getSessionInputActor(captured).then((inputActor) => {
    const admission = inputActor ? undefined : resolveSqliteWriteAdmissionScope(captured);
    const stage = async () => {
      const store = await preparePendingInputStore(
        captured,
        options.authority?.assertLifetimeCurrent ?? options.assertCurrent,
      );
      const accept = () =>
        stagePreparedPendingInput(captured, options, preparedRequest, lifecycleGeneration, store);
      // Actor commands own the physical FIFO and revalidate the prepared snapshot.
      // Holding the legacy reservation here would make native acceptance queue behind itself.
      return inputActor ? accept() : store.withAdmission(accept, admission !== undefined);
    };
    return admission
      ? runOpenClawAgentWriteAdmission(toDatabaseOptions(admission), stage)
      : stage();
  });
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
  const assertPrepared = (
    facts: PendingInputCustodyGrant | undefined,
    guard: () => void,
    assertSourceCurrent = store.assertCurrent,
  ) => {
    if (options.authority) {
      if (!facts?.authority) {
        throw new Error("Pending input grant omitted its current session authority");
      }
      return options.authority.withPreparedCurrent(facts.authority, guard, assertSourceCurrent);
    }
    return guard();
  };
  const assertCurrent = () =>
    options.authority
      ? options.authority.withCurrent(() => options.assertCurrent())
      : options.assertCurrent();
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
    await assertCurrent();
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
      ...(options.authority ? { authorityAgentId: scope.agentId } : {}),
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
          (options.authority?.assertLifetimeCurrent ?? assertCompletion)();
          completion = store
            .mutate(completionInput(outcome), (_stage, facts) =>
              assertPrepared(facts, assertCompletion),
            )
            .then((receipt) => {
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
          const receipt = await store.mutate(
            { ...settlementIdentity(), kind: "finish", inputId: owner.inputId, disposition },
            () => assertRegisteredSessionPendingInputOwner(owner!),
          );
          if (receipt.withdrawnInputId === owner.inputId) {
            withdrawnOwners.add(owner);
          }
        }
      };
      const ending = completion
        ? completion
            .catch((error: unknown) => {
              rethrowIncognitoSessionError(error);
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
        await assertCurrent();
      }
      retained = true;
      const run = <T>(operation: () => T) => {
        store.assertCurrent();
        if (finished) {
          throw new SessionPendingInputCustodyError("Pending input ownership ended");
        }
        scope.incognito?.authority.assertCurrent();
        options.assertCurrent();
        return operation();
      };
      return {
        state: "queued",
        inputId: committed.messageId,
        message: committed.message,
        run,
        assertLifetimeCurrent: () => {
          store.assertCurrent();
          (options.authority?.assertLifetimeCurrent ?? options.assertCurrent)();
        },
        runAsync: <T>(operation: () => T): Promise<Awaited<T>> =>
          withCurrentPendingInputAuthority(
            options.authority ? [options.authority] : [],
            () => {
              store.assertCurrent();
              options.authority?.assertLifetimeCurrent();
            },
            () => run(operation),
          ),
        finish,
        ...completionMethods,
      };
    }
    const prepareMessage = () => {
      options.assertCurrent();
      return options.prepareMessageAfterIdempotencyCheck!(message);
    };
    const prepared = existing
      ? parseSessionPendingInputMessage(existing.message_json)
      : options.prepareMessageAfterIdempotencyCheck
        ? options.authority
          ? await options.authority.withCurrent(prepareMessage)
          : prepareMessage()
        : message;
    if (!prepared) {
      return undefined;
    }
    const messageJson =
      existing?.message_json ?? JSON.stringify(sanitizeTranscriptMessageForStorage(prepared));
    if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error("Approved pending input exceeds the Gateway payload limit");
    }
    const inputId = existing?.input_id ?? randomUUID();
    const assertAdmittedCurrent = options.assertAdmittedCurrent ?? options.assertCurrent;
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
        assertPrepared(facts, () => {
          options.assertCurrent();
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          assertUnowned(facts?.candidate);
        });
      },
      (facts, assertSourceCurrent) => {
        const staged = facts?.receipt.stagedInput;
        if (!staged) {
          throw new SessionPendingInputCustodyError(
            "Pending input omitted its committed postimage",
          );
        }
        owner = {
          agentId: scope.agentId,
          databaseAgentId: store.databaseAgentId,
          inputId: staged.input_id,
          transcriptInputId: staged.input_id,
          sessionId: scope.sessionId,
          sessionKey: store.sessionKey,
          databasePath: store.path,
          workerDatabasePath: store.workerDatabasePath,
          idempotencyKey: identity.idempotencyKey,
          lifecycleGeneration,
          messageJson: staged.message_json,
          config: options.config,
          assertCurrent: () => {
            store.assertCurrent();
            scope.incognito?.actor.assertCurrent();
            scope.incognito?.authority.assertCurrent();
            assertAdmittedCurrent();
          },
          authority: options.authority,
          ...(existing ? { restartRecovered: true as const } : {}),
          finish,
        };
        // COMMIT already accepted this custody. Preserve it before fallible publication.
        registerSessionPendingInputOwner(owner);
        retained = true;
        options.onCommitted?.(Object.assign(ownerReceipt(owner), completionMethods));
        assertPrepared(
          facts,
          () => {
            options.assertCurrent();
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          },
          assertSourceCurrent,
        );
      },
    );
    if (!owner) {
      throw new SessionPendingInputCustodyError(
        "Pending input did not publish its committed owner",
      );
    }
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

/** Prepare evidence; only the later synchronous claim may spend recovered host custody. */
export async function prepareSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): Promise<(() => boolean) | undefined> {
  const claim = prepareCurrentSessionPendingInputDedupeRecovery(
    { ...scope, sessionKey: resolveSqliteSessionKey(scope.sessionKey, scope.agentId) },
    runId,
  );
  if (!claim) {
    return undefined;
  }
  const source = await readPendingInputSource(scope, `${runId}:user`, true);
  return source
    ? () => {
        source.assertCurrent();
        return claim(source.path, source.snapshot);
      }
    : undefined;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export async function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): Promise<PersistedUserTurnMessage | undefined> {
  const source = await readPendingInputSource(scope, idempotencyKey, false);
  if (!source?.snapshot.current) {
    return undefined;
  }
  source.assertCurrent();
  const { pending, committed } = source.snapshot;
  const message = pending ? parseSessionPendingInputMessage(pending.message_json) : committed;
  return message && readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
}
