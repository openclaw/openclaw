import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { decodeRequesterOrigin, type RequesterOrigin } from "../../agents/requester-origin.js";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "../../chat/message-client-source.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import {
  getAgentEventLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { throwIfSettledRejected } from "../../infra/error-graph-internal.js";
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
  type SessionPendingInputPage,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteSessionKey,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { sanitizeTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { getSessionInputActor } from "./session-input-actor.js";
import type { SessionInputLifecycleAdmission } from "./session-input-lifecycle.js";
import {
  withCurrentPendingInputAuthority,
  type SessionPendingInputAuthority,
} from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { PendingInputCustodyGrant } from "./session-pending-input-operations.types.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import type { SessionPendingInputReceipt } from "./session-pending-input-receipt.types.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import { preparePendingInputStore, type PendingInputScope } from "./session-pending-input-store.js";
import {
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
} from "./session-pending-input-value.js";
import {
  runWithSessionSourceScope,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export { withSessionPendingInputRelocation };
export { prepareForeignLiveSessionPendingInputEntries } from "./session-pending-input-live-read.js";
export type { SessionPendingInput, SessionPendingInputPage, SessionPendingInputReceipt };

const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();
const withdrawnOwners = new WeakSet<SessionPendingInputOwner>();

/** The private accepted bytes survive mutable receipt projections and replay preparation. */
export function readSessionPendingInputRequesterOrigin(
  receipt: SessionPendingInputReceipt,
): RequesterOrigin | undefined {
  const owner = receiptOwners.get(receipt);
  if (!owner) {
    return undefined;
  }
  assertSessionPendingInputLifetimeCurrent(owner);
  return owner.requesterOrigin;
}

export function readWithdrawnSessionPendingInputId(
  receipt: SessionPendingInputReceipt | undefined,
): string | undefined {
  const owner = receipt && receiptOwners.get(receipt);
  return owner && withdrawnOwners.has(owner) ? owner.inputId : undefined;
}

function ownerReceipt(
  owner: SessionPendingInputOwner,
  queuedReplay?: true,
): SessionPendingInputReceipt {
  const message = parseSessionPendingInputMessage(owner.messageJson);
  owner.requesterOrigin ??= decodeRequesterOrigin(message["__openclaw"]?.requesterOrigin);
  const receipt: SessionPendingInputReceipt = {
    get state() {
      return !queuedReplay && (owner.consumed || owner.sources?.every((source) => source.consumed))
        ? "consumed"
        : "queued";
    },
    inputId: queuedReplay ? owner.transcriptInputId : owner.inputId,
    message,
    run: (operation) => runWithSessionPendingInput(owner, operation),
    runAsync: (operation) =>
      runWithSessionPendingInputPersistence(owner, () =>
        withCurrentPendingInputAuthority(
          (owner.sources ?? [owner]).flatMap((source) =>
            source.authority ? [source.authority] : [],
          ),
          () => assertSessionPendingInputLifetimeCurrent(owner),
          () => runWithSessionPendingInput(owner, operation),
        ),
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

function finishPendingInputSources(
  sources: readonly SessionPendingInputOwner[],
  disposition: "cancelled" | "interrupted",
): void {
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
        // Committed replays already have a transcript entry and cannot be collected again.
        return owner && !owner.consumed ? (owner.sources ?? [owner]) : [];
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
  // Collected framing still passes storage preparation; its staged sources have
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
    // Source owners release their admission closures when settlement completes.
    assertCurrent: assertSessionPendingInputLifetimeCurrent.bind(undefined, first),
    authority: undefined,
    requesterOrigin: undefined,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: finishPendingInputSources.bind(undefined, sources),
  });
  aggregate.settled = async () => {
    const results = await Promise.allSettled(receipts.map(async (receipt) => receipt.settled?.()));
    throwIfSettledRejected(results, "Failed to settle collected input custody");
  };
  return aggregate;
}

type PendingInputStageOptions = PendingInputRequest & {
  lifecycleAdmission?: SessionInputLifecycleAdmission;
  onCommitted?: (receipt: SessionPendingInputReceipt) => void;
  authority?: SessionPendingInputAuthority;
  trackCompletion?: boolean;
  /** A current explicit operation may retry its cancelled, unconsumed input. */
  retryCancelled?: boolean;
  assertCurrent: () => void;
  /** Fresh source acceptance only; recorded pending and transcript inputs keep their prior consent. */
  assertFreshInputCurrent?: SessionSourceAssertion;
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
  if (
    captureSessionActorStorageOwner(scope, {
      assertCurrent: options.assertCurrent,
      authorize: options.assertCurrent,
    })
  ) {
    return preparePendingInputStore(
      captured,
      options.authority?.assertLifetimeCurrent ?? options.assertCurrent,
    ).then((store) => {
      const binding = store.sessionActor;
      if (!binding) {
        throw new Error("Incognito pending input omitted its actor");
      }
      return runWithSessionActorStorage(binding, () =>
        stagePreparedPendingInput(
          { ...captured, sessionActor: binding },
          options,
          preparedRequest,
          lifecycleGeneration,
          store,
        ),
      );
    });
  }
  return getSessionInputActor(captured).then((inputActor) => {
    const admission = inputActor ? undefined : resolveSqliteWriteAdmissionScope(captured);
    const stage = async () => {
      const store = await preparePendingInputStore(
        captured,
        options.authority?.assertLifetimeCurrent ?? options.assertCurrent,
        options.lifecycleAdmission,
      );
      const accept = () =>
        stagePreparedPendingInput(captured, options, preparedRequest, lifecycleGeneration, store);
      // Actor commands own the physical FIFO and check the admitted input's identity.
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
  using phase = observeDiagnosticsTimelinePhases("persist.stage.read");
  let retained = false;
  let finished = false;
  let owner: SessionPendingInputOwner | undefined;
  let completion: Promise<AgentRunTerminalOutcome> | undefined;
  const assertPrepared = (
    facts: PendingInputCustodyGrant | undefined,
    guard: () => void,
    assertSourceCurrent = store.assertCurrent,
  ) => {
    using _ = observeDiagnosticsTimelinePhases("persist.stage.commitAuthority");
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
    phase.mark("persist.stage.authority");
    const { current, existing, previous, committed } = snapshot;
    const fresh = current && !(existing || previous || committed);
    // Approval rechecks fresh input; replay needs a full read before disclosure.
    await (fresh && options.prepareMessageAfterIdempotencyCheck
      ? (options.authority?.prepareForSourceScope?.() ?? assertCurrent())
      : assertCurrent());
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    if (!current) {
      return undefined;
    }
