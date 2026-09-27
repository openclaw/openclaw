import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceCancelParams,
  type WorkerInferenceErrorReason,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceEventFrame,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerInferenceSessionControls,
  joinInferenceOperations,
  matchesIdentity,
  preserveInferenceAuthorityFailure,
  safeRevalidate,
  WorkerInferenceAuthorityError,
} from "./inference-control-internal.js";
import {
  normalizeTerminalOutcome,
  terminalError,
  terminalFrame,
  validFrameBytes,
} from "./inference-frames.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import type {
  ActiveInference,
  InferenceTurnIdentity,
  RevalidateInference,
  WorkerInferenceCancelApplicationResult,
  WorkerInferenceManagerOptions,
  WorkerInferenceSink,
  WorkerInferenceStartApplicationResult,
} from "./inference.types.js";
import {
  serializeWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { formatWorkerInferenceError } from "./worker-error.js";

export type { WorkerInferenceExecutor, WorkerInferenceSink } from "./inference.types.js";

const DEFAULT_REQUEST_MAX_BYTES = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES;
// One active turn plus one provider that ignored abort. This prevents repeated
// cancel/restart from creating unbounded provider work without wedging the session forever.
const MAX_PROVIDER_OPERATIONS_PER_SESSION = 2;

function inferenceTurnKey(input: InferenceTurnIdentity): string {
  return JSON.stringify([input.sessionId, input.runEpoch, input.runId, input.turnId]);
}

function trySend(
  sink: WorkerInferenceSink,
  frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
): boolean {
  try {
    sink.send(frame);
    return true;
  } catch {
    return false;
  }
}

export function createWorkerInferenceManager(options: WorkerInferenceManagerOptions) {
  const store = options.store ?? createWorkerInferenceStore();
  const requestMaxBytes = options.requestMaxBytes ?? DEFAULT_REQUEST_MAX_BYTES;
  const streamMaxBytes = options.streamMaxBytes ?? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES;
  const active = new Map<string, ActiveInference>();
  const operations = new Map<Promise<unknown>, { sessionId: string; storeKey: string }>();
  const providers = new Map<Promise<void>, string>();
  const unknownSettlements = new Map<string, Set<unknown>>();
  const retainUnknown = (storeKey: string, error: unknown) => {
    if (!hasSqliteWorkerOutcomeUnknown(error)) {
      return;
    }
    let failures = unknownSettlements.get(storeKey);
    if (!failures) {
      failures = new Set();
      unknownSettlements.set(storeKey, failures);
    }
    failures.add(error);
  };
  const unknownFailureFor = (storeKey: string): unknown => {
    const errors = [...(unknownSettlements.get(storeKey) ?? [])];
    return errors.length > 1
      ? new AggregateError(errors, "Worker inference settlement failed")
      : errors[0];
  };
  const assertKnownTurn = (storeKey: string) => {
    if (unknownSettlements.has(storeKey)) {
      throw unknownFailureFor(storeKey);
    }
  };
  const recovered = store.recoverPending(terminalError("provider-error"));
  // Startup and every admitted operation join the original recovery result.
  void recovered.catch(() => undefined);

  const track = <T>(operation: Promise<T>, input: InferenceTurnIdentity): Promise<T> => {
    const storeKey = inferenceTurnKey(input);
    operations.set(operation, { sessionId: input.sessionId, storeKey });
    void operation.then(
      () => operations.delete(operation),
      (error: unknown) => {
        operations.delete(operation);
        retainUnknown(storeKey, error);
      },
    );
    return operation;
  };
  const processFence = (entry: ActiveInference): WorkerInferenceErrorReason | null => {
    if (entry.abortReason) {
      return entry.abortReason;
    }
    if (unknownSettlements.has(entry.storeKey)) {
      return "provider-error";
    }
    const bindingError = matchesIdentity(entry.identity, entry.request);
    if (bindingError) {
      return bindingError;
    }
    return active.get(entry.claimKey) === entry ? null : "cancelled";
  };
  const abortEntry = (entry: ActiveInference, reason: WorkerInferenceErrorReason): void => {
    entry.abortReason ??= reason;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort();
    }
  };
  const durableFence = (entry: ActiveInference): WorkerInferenceErrorReason | null => {
    const processError = processFence(entry);
    if (processError) {
      return processError;
    }
    const revalidationError = safeRevalidate(
      entry.revalidate,
      (error) => {
        entry.authorityFailure ??= { error };
      },
      entry.assertSourceCurrent,
    );
    if (revalidationError) {
      abortEntry(entry, revalidationError);
    }
    return revalidationError;
  };
  const assertEntry = (entry: ActiveInference) => {
    assertKnownTurn(entry.storeKey);
    if (active.get(entry.claimKey) !== entry) {
      throw new WorkerInferenceAuthorityError("cancelled");
    }
  };
  const assertLiveEntry = (entry: ActiveInference) => {
    assertKnownTurn(entry.storeKey);
    const reason = durableFence(entry);
    if (entry.authorityFailure && hasSqliteWorkerOutcomeUnknown(entry.authorityFailure.error)) {
      throw entry.authorityFailure.error;
    }
    if (reason) {
      throw new WorkerInferenceAuthorityError(reason, entry.authorityFailure?.error);
    }
  };
  const forget = (entry: ActiveInference) => {
    if (active.get(entry.claimKey) === entry) {
      active.delete(entry.claimKey);
    }
  };
  const sendFrame = (
    entry: ActiveInference,
    frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
  ): boolean => {
    if (!entry.sinkReady) {
      entry.pendingFrames.push(frame);
      return true;
    }
    return trySend(entry.sink, frame);
  };
  const sendTerminal = (entry: ActiveInference, outcome: WorkerInferenceTerminalOutcome): void => {
    entry.seq += 1;
    sendFrame(entry, terminalFrame(entry, outcome, entry.seq));
  };
  const retainFailure = (entry: ActiveInference, error: unknown) => {
    entry.failure ??= { error };
    retainUnknown(entry.storeKey, error);
    entry.settled = true;
    abortEntry(entry, "provider-error");
  };

  const finish = (
    entry: ActiveInference,
    rawOutcome: WorkerInferenceTerminalOutcome,
  ): Promise<void> => {
    if (entry.terminal) {
      return entry.terminal;
    }
    if (unknownSettlements.has(entry.storeKey)) {
      return joinInferenceOperations([], [unknownFailureFor(entry.storeKey)]);
    }
    if (entry.failure) {
      return joinInferenceOperations([], [entry.failure.error]);
    }
    if (entry.settled) {
      return Promise.resolve();
    }
    // The first terminal operation owns this identity through native settlement.
    // Cancellation can abort a provider immediately, but never submits a second write.
    entry.terminal = track(
      (async () => {
        try {
          const begin = await entry.begun;
          assertKnownTurn(entry.storeKey);
          if (!begin || begin.kind === "rejected") {
            entry.settled = true;
            forget(entry);
            return;
          }
          if (begin.kind === "replay") {
            entry.settled = true;
            forget(entry);
            return;
          }
          const fence = durableFence(entry);
          if (
            entry.authorityFailure &&
            hasSqliteWorkerOutcomeUnknown(entry.authorityFailure.error)
          ) {
            throw entry.authorityFailure.error;
          }
          const outcome = normalizeTerminalOutcome(
            entry,
            fence ? terminalError(fence, rawOutcome) : rawOutcome,
          );
          let storedOutcome: WorkerInferenceTerminalOutcome;
          try {
            storedOutcome = await store.complete(
              { ...entry.storeInput, outcome },
              fence ? () => assertEntry(entry) : () => assertLiveEntry(entry),
            );
          } catch (error) {
            if (
              !(error instanceof WorkerInferenceAuthorityError) ||
              hasSqliteWorkerOutcomeUnknown(error)
            ) {
              throw error;
            }
            // A refused live-authority grant rolls back the first transaction. The
            // captured registration still owns its cancellation receipt, never a retry
            // of an uncertain write or a provider success under retired authority.
            storedOutcome = await store.complete(
              { ...entry.storeInput, outcome: terminalError(error.reason, rawOutcome) },
              () => assertEntry(entry),
            );
          }
          entry.settled = true;
          entry.terminalOutcome = storedOutcome;
          if (active.get(entry.claimKey) === entry) {
            forget(entry);
            if (!entry.replay) {
              sendTerminal(entry, storedOutcome);
            }
          }
          if (entry.authorityFailure) {
            throw entry.authorityFailure.error;
          }
        } catch (error) {
          const failure = preserveInferenceAuthorityFailure(error, entry.authorityFailure);
          retainFailure(entry, failure);
          throw failure;
        }
      })(),
      entry.storeInput,
    );
    return entry.terminal;
  };
  const settleAbort = (
    entry: ActiveInference,
    reason: WorkerInferenceErrorReason,
  ): Promise<void> => {
    abortEntry(entry, reason);
    return finish(entry, terminalError(entry.abortReason ?? reason));
  };
  const controls = createWorkerInferenceSessionControls({
    active,
    operations,
    unknownSettlements,
    recovered,
    settleAbort,
  });
  const executeEntry = async (entry: ActiveInference): Promise<void> => {
    const initialFence = durableFence(entry);
    if (initialFence) {
      if (entry.authorityFailure && hasSqliteWorkerOutcomeUnknown(entry.authorityFailure.error)) {
        retainFailure(entry, entry.authorityFailure.error);
        throw entry.authorityFailure.error;
      }
      await joinInferenceOperations(
        [finish(entry, terminalError(initialFence))],
        entry.authorityFailure ? [entry.authorityFailure.error] : [],
      );
      return;
    }
    let outcome: WorkerInferenceTerminalOutcome;
    let failure: { error: unknown } | undefined;
    try {
      const config = options.getConfig?.();
      outcome = await options.execute({
        identity: entry.identity,
        request: entry.request,
        sessionTarget: entry.sessionTarget,
        signal: entry.controller.signal,
        emit: (event) => {
          const fence = durableFence(entry);
          if (fence) {
            abortEntry(entry, fence);
            return;
          }
          const nextSeq = entry.seq + 1;
          const frame: WorkerInferenceEventFrame = {
            type: "event",
            event: "worker.inference.event",
            payload: {
              runEpoch: entry.request.runEpoch,
              sessionId: entry.request.sessionId,
              runId: entry.request.runId,
              turnId: entry.request.turnId,
              seq: nextSeq,
              event,
            },
          };
          const frameBytes = validFrameBytes(frame, validateWorkerInferenceEventFrame);
          if (
            frameBytes === null ||
            entry.streamedBytes + frameBytes > streamMaxBytes ||
            !sendFrame(entry, frame)
          ) {
            void settleAbort(entry, "provider-error").catch(() => undefined);
            return;
          }
          entry.streamedBytes += frameBytes;
          entry.seq = nextSeq;
        },
        isCurrent: () => durableFence(entry) === null,
        ...(config ? { config } : {}),
      });
    } catch (caught) {
      const error = preserveInferenceAuthorityFailure(caught, entry.authorityFailure);
      failure = { error };
      outcome = terminalError(
        entry.abortReason ?? "provider-error",
        undefined,
        entry.abortReason ? undefined : formatWorkerInferenceError(error),
      );
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        retainFailure(entry, error);
        // Native uncertainty is a local settlement failure, never another terminal mutation.
        if (entry.terminal) {
          await joinInferenceOperations([entry.terminal], [error]);
        }
        throw error;
      }
    }
    failure ??= entry.authorityFailure;
    await joinInferenceOperations([finish(entry, outcome)], failure ? [failure.error] : []);
  };
  const launchEntry = (entry: ActiveInference): void => {
    if (
      entry.launched ||
      entry.settled ||
      entry.abortReason ||
      controls.isStopping() ||
      controls.isDraining(entry.request.sessionId)
    ) {
      return;
    }
    entry.launched = true;
    // Register the raw operation before executor callbacks can reserve a drain.
    const operation = track(
      runWithGatewayIndependentRootWorkContinuation(
        () => Promise.resolve().then(() => executeEntry(entry)),
        "worker:dispatch",
      ),
      entry.storeInput,
    );
    providers.set(operation, entry.request.sessionId);
    void operation.then(
      () => providers.delete(operation),
      (error: unknown) => {
        providers.delete(operation);
        if (!entry.settled || hasSqliteWorkerOutcomeUnknown(error)) {
          retainFailure(entry, error);
        }
      },
    );
  };

  const acceptedResult = (
    entry: ActiveInference,
    sink: WorkerInferenceSink,
  ): WorkerInferenceStartApplicationResult => ({
    ok: true,
    result: { status: "accepted" },
    launch() {
      // Each connection acknowledges its own admission before it can receive
      // buffered events. An earlier coalesced caller cannot launch its successor sink.
      if (entry.sink !== sink) {
        return;
      }
      entry.sinkReady = true;
      for (const frame of entry.pendingFrames.splice(0)) {
        if (!trySend(sink, frame)) {
          void settleAbort(entry, "provider-error").catch(() => undefined);
          return;
        }
      }
      launchEntry(entry);
    },
  });

  const replayResult = (
    entry: ActiveInference,
    outcome: WorkerInferenceTerminalOutcome,
    sink: WorkerInferenceSink,
  ): WorkerInferenceStartApplicationResult => {
    let launched = false;
    entry.settled = true;
    entry.terminalOutcome = outcome;
    forget(entry);
    return {
      ok: true,
      result: { status: "replayed" },
      launch() {
        if (launched || entry.sink !== sink) {
          return;
        }
        launched = true;
        entry.sinkReady = true;
        const fence =
          entry.abortReason ??
          safeRevalidate(
            entry.revalidate,
            (error) => retainUnknown(entry.storeKey, error),
            entry.assertSourceCurrent,
          );
        if (!unknownSettlements.has(entry.storeKey)) {
          sendTerminal(entry, fence ? terminalError(fence) : outcome);
        }
      },
    };
  };
  const start = async (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerInferenceStartParams;
    sink: WorkerInferenceSink;
    sessionTarget: BoundAgentRunSessionTarget;
    assertSourceCurrent?: () => void;
    revalidate?: RevalidateInference;
  }): Promise<WorkerInferenceStartApplicationResult> => {
    const assertSourceCurrent = params.assertSourceCurrent;
    if (controls.isStopping() || controls.isDraining(params.request.sessionId)) {
      return { ok: false, reason: "cancelled" };
    }
    if (unknownSettlements.has(inferenceTurnKey(params.request))) {
      return { ok: false, reason: "provider-error" };
    }
    const identityError = matchesIdentity(params.identity, params.request);
    if (identityError) {
      return { ok: false, reason: identityError };
    }
    // No inference work is admitted yet; return the original authority failure to
    // this caller without giving a later session drain custody of the attempt.
    assertSourceCurrent?.();
    const revalidationError = params.revalidate?.() ?? null;
    if (revalidationError) {
      return { ok: false, reason: revalidationError };
    }
    // An unresolved executor has no separate proof that it lost write capability.
    // Only uncertain predecessors require this join; ordinary canceled providers
    // retain the existing bounded overlap allowance.
    if (
      [...operations.values()].some(
        (owner) =>
          owner.sessionId === params.request.sessionId && unknownSettlements.has(owner.storeKey),
      )
    ) {
      return { ok: false, reason: "provider-error" };
    }
    const measured = boundedJsonUtf8Bytes(params.request, requestMaxBytes);
    if (!measured.complete || measured.bytes > requestMaxBytes) {
      return { ok: false, reason: "invalid-context" };
    }
    const serialized = stableStringify(params.request);
    const claimKey = serializeWorkerSessionTurnClaim(params.identity.turnClaim!);
    const hash = createHash("sha256").update(`${claimKey}\0${serialized}`).digest("hex");
    // An explicit retry reconciles a known failure through durable begin/replay.
    // A new identity may replace an uncertain predecessor only after its raw work
    // settles; the predecessor's own key remains fenced above.
    for (const previous of active.values()) {
      if (previous.request.sessionId === params.request.sessionId && previous.failure) {
        forget(previous);
      }
    }
    const existing = active.get(claimKey);
    if (
      existing &&
      existing.request.turnId === params.request.turnId &&
      existing.requestHash === hash &&
      !existing.settled
    ) {
      existing.identity = params.identity;
      existing.sink = params.sink;
      existing.sinkReady = false;
      existing.revalidate = params.revalidate;
      const result = await existing.admission!;
      if (!result.ok) {
        return result;
      }
      return result.result.status === "accepted"
        ? acceptedResult(existing, params.sink)
        : replayResult(existing, existing.terminalOutcome!, params.sink);
    }
    for (const concurrent of active.values()) {
      if (concurrent.request.sessionId !== params.request.sessionId) {
        continue;
      }
      const fence = durableFence(concurrent);
      if (fence) {
        try {
          await settleAbort(concurrent, fence);
        } catch {
          return { ok: false, reason: "provider-error" };
        }
      }
      return { ok: false, reason: "invalid-context" };
    }
    const entry: ActiveInference = {
      claimKey,
      storeKey: inferenceTurnKey(params.request),
      identity: params.identity,
      request: structuredClone(params.request),
      sessionTarget: params.sessionTarget,
      requestHash: hash,
      storeInput: {
        environmentId: params.identity.environmentId,
        sessionId: params.request.sessionId,
        runEpoch: params.request.runEpoch,
        runId: params.request.runId,
        turnId: params.request.turnId,
        requestHash: hash,
      },
      sink: params.sink,
      sinkReady: false,
      pendingFrames: [],
      ...(assertSourceCurrent ? { assertSourceCurrent } : {}),
      ...(params.revalidate ? { revalidate: params.revalidate } : {}),
      controller: new AbortController(),
      seq: 0,
      streamedBytes: 0,
      launched: false,
      settled: false,
    };
    // Register before recovery or BEGIN can yield, so Stop and drains own pending admissions.
    active.set(claimKey, entry);
    entry.begun = track(
      (async () => {
        await recovered;
        if (entry.abortReason) {
          return undefined;
        }
        try {
          return await store.begin(entry.storeInput, () => assertLiveEntry(entry));
        } catch (error) {
          if (
            error instanceof WorkerInferenceAuthorityError &&
            !hasSqliteWorkerOutcomeUnknown(error) &&
            !entry.authorityFailure
          ) {
            abortEntry(entry, error.reason);
            return undefined;
          }
          const failure = preserveInferenceAuthorityFailure(error, entry.authorityFailure);
          retainFailure(entry, failure);
          throw failure;
        }
      })(),
      entry.storeInput,
    );
    const admission = track(
      (async (): Promise<WorkerInferenceStartApplicationResult> => {
        const begin = await entry.begun;
        assertKnownTurn(entry.storeKey);
        if (!begin || begin.kind === "rejected") {
          forget(entry);
          return { ok: false, reason: entry.abortReason ?? "invalid-context" };
        }
        if (begin.kind === "replay") {
          return replayResult(entry, begin.outcome, params.sink);
        }
        if (begin.kind === "recover") {
          entry.replay = true;
          await finish(entry, terminalError("provider-error"));
          return replayResult(entry, entry.terminalOutcome!, params.sink);
        }
        const fence = durableFence(entry);
        // An accepted drain owns cancellation; its pending acknowledgment stays inert.
        if (fence || (controls.isStopping() && !controls.isDraining(entry.request.sessionId))) {
          await settleAbort(entry, fence ?? "cancelled");
          return acceptedResult(entry, params.sink);
        }
        const running = [...providers.values()].filter(
          (sessionId) => sessionId === entry.request.sessionId,
        ).length;
        if (running >= MAX_PROVIDER_OPERATIONS_PER_SESSION) {
          entry.replay = true;
          await finish(entry, terminalError("provider-error"));
          return replayResult(entry, entry.terminalOutcome!, params.sink);
        }
        return acceptedResult(entry, params.sink);
      })(),
      entry.storeInput,
    );
    entry.admission = admission.catch((error: unknown): WorkerInferenceStartApplicationResult => {
      retainFailure(entry, error);
      return { ok: false, reason: "provider-error" };
    });
    return await entry.admission;
  };

  const cancelOperation = async (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerInferenceCancelParams;
    revalidate?: RevalidateInference;
  }): Promise<WorkerInferenceCancelApplicationResult> => {
    if (unknownSettlements.has(inferenceTurnKey(params.request))) {
      await joinInferenceOperations([], unknownSettlements.get(inferenceTurnKey(params.request)));
    }
    const claimKey = serializeWorkerSessionTurnClaim(params.identity.turnClaim!);
    const failed = active.get(claimKey);
    if (failed?.failure && !hasSqliteWorkerOutcomeUnknown(failed.failure.error)) {
      forget(failed);
    }
    const entry = active.get(claimKey);
    if (entry?.request.turnId === params.request.turnId) {
      await settleAbort(entry, "cancelled");
    } else {
      await track(
        (async () => {
          await recovered;
          assertKnownTurn(inferenceTurnKey(params.request));
          let authorityFailure: { error: unknown } | undefined;
          try {
            await store.cancelPending(
              {
                environmentId: params.identity.environmentId,
                sessionId: params.request.sessionId,
                runEpoch: params.request.runEpoch,
                runId: params.request.runId,
                turnId: params.request.turnId,
                outcome: terminalError("cancelled"),
              },
              () => {
                assertKnownTurn(inferenceTurnKey(params.request));
                const failure = safeRevalidate(params.revalidate, (error) => {
                  authorityFailure ??= { error };
                  retainUnknown(inferenceTurnKey(params.request), error);
                });
                if (failure) {
                  throw authorityFailure
                    ? authorityFailure.error
                    : new WorkerInferenceAuthorityError(failure);
                }
              },
            );
          } catch (error) {
            throw preserveInferenceAuthorityFailure(error, authorityFailure);
          }
        })(),
        params.request,
      );
    }
    return { ok: true, result: { status: "cancelled" } };
  };

  const cancel = async (
    params: Parameters<typeof cancelOperation>[0],
  ): Promise<WorkerInferenceCancelApplicationResult> => {
    const reason =
      matchesIdentity(params.identity, params.request) ?? params.revalidate?.() ?? null;
    if (reason) {
      return { ok: false, reason };
    }
    if (unknownSettlements.has(inferenceTurnKey(params.request))) {
      return { ok: false, reason: "provider-error" };
    }
    const closing = controls.getClosing(params.request.sessionId);
    if (closing) {
      // A later RPC joins accepted cancellation without starting native work
      // before its deferred start or outside the original drain's custody.
      return closing.then(
        () => ({ ok: true, result: { status: "cancelled" } }),
        () => ({ ok: false, reason: "provider-error" }),
      );
    }
    return track(cancelOperation(params), params.request).catch(() => ({
      ok: false,
      reason: "provider-error",
    }));
  };
  return {
    ready: () => recovered,
    start,
    cancel,
    cancelEnvironment: controls.cancelEnvironment,
    cancelClaim: (claim: WorkerSessionTurnClaim) =>
      controls.cancelClaim(serializeWorkerSessionTurnClaim(claim)),
    cancelSession: controls.cancelSession,
    captureSessionCancellation: controls.captureSessionCancellation,
    reserveSessionDrain: controls.reserveSessionDrain,
    hasSession: controls.hasSession,
    resolveSessionTargetForRunId: controls.resolveSessionTargetForRunId,
    stop: controls.stop,
  };
}
