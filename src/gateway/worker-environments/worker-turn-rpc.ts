import { randomUUID } from "node:crypto";
import type {
  WorkerConnectParams,
  WorkerLiveEventParams,
  WorkerProtocolCloseReason,
  WorkerTranscriptCommitParams,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerGatewayToolCancelParams,
  WorkerGatewayToolInvokeParams,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type {
  WorkerInferenceCancelParams,
  WorkerInferenceStartParams,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  admitWorkerConnection,
  validateWorkerConnectionIdentity,
  type ExpectedWorkerBuild,
  type WorkerConnectionIdentity,
} from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createWorkerInferenceManager, type WorkerInferenceSink } from "./inference.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import {
  acknowledgeWorkerTurnFinishing,
  getWorkerTurnToolSurface,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerEnvironmentStore } from "./store.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";
import type { WorkerGatewayToolSink } from "./worker-gateway-tool-contract.js";
import { workerSessionToolErrorResult } from "./worker-session-tool-result.js";
import {
  createWorkerComputerRpc,
  type WorkerComputerExecutor,
} from "./worker-turn-computer-rpc.js";
import type {
  WorkerProcessTurnBinding,
  WorkerTerminalTurnFence,
  WorkerPendingTerminalTurnFence,
  WorkerTurnRequest,
  WorkerPlacementValidation,
  WorkerTranscriptCommitServiceResult,
  WorkerLiveEventServiceResult,
  WorkerInferenceServiceResult,
} from "./worker-turn-rpc.types.js";
import { captureWorkerTurnLiveEventOwner } from "./worker-turn-run-owner.js";

class WorkerTranscriptAuthorityError extends Error {
  constructor(readonly outcome: Exclude<WorkerTranscriptCommitServiceResult, { ok: true }>) {
    super("Worker transcript authority closed");
  }
}

type WorkerTurnRpcOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  applyTranscriptCommit?: WorkerTranscriptCommitApplication;
  liveEvents?: Pick<WorkerLiveEventReceiver, "apply">;
  placementStore?: WorkerSessionPlacementGate;
  executeComputer?: WorkerComputerExecutor;
  inference: ReturnType<typeof createWorkerInferenceManager>;
  isStopping: () => boolean;
  now: () => number;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerTurnRpc(options: WorkerTurnRpcOptions) {
  const { store } = options;
  const inference = options.inference;
  const now = options.now;
  const withLock = options.withLock;
  const observedAckCursors = new Map<string, WorkerTerminalTurnFence>();
  const pendingTerminalTurnFences = new Map<string, WorkerPendingTerminalTurnFence>();
  const terminalTurnFences = new Map<string, WorkerTerminalTurnFence>();
  const workerAdmissionReceiptScope = randomUUID();
  let workerAdmissionOrdinal = 0;

  const placementClaim = (identity: WorkerConnectionIdentity) => identity.turnClaim ?? undefined;

  const sourceFor = (identity: WorkerConnectionIdentity) => {
    const claim = placementClaim(identity);
    return claim ? options.placementStore?.getExecutionIdentityCapability?.(claim) : undefined;
  };

  const processTurnBinding = (
    identity: WorkerConnectionIdentity,
  ): WorkerProcessTurnBinding | undefined => {
    const turnClaim = placementClaim(identity);
    return turnClaim ? { turnClaim, credentialHash: identity.credentialHash } : undefined;
  };

  const admitWorkerAt = (
    admission: WorkerConnectParams["admission"],
    expectedBuild: ExpectedWorkerBuild,
    nowMs: number,
  ) => {
    const claim =
      admission.sessionId !== null
        ? options.placementStore?.readWorkerTurnClaim({
            sessionId: admission.sessionId,
            environmentId: admission.environmentId,
            ownerEpoch: admission.ownerEpoch,
          })
        : undefined;
    return admitWorkerConnection({
      store,
      admission,
      expectedBuild,
      nowMs,
      ...(claim ? { turnClaim: claim } : {}),
      allowExpiredCredential: true,
    });
  };

  const finishWorkerAdmission = <T extends { ok: boolean; reason?: string }>(
    admission: WorkerConnectParams["admission"],
    result: T,
    capability: WorkerTurnExecutionIdentityCapability | undefined,
  ): T => {
    if (!capability) {
      return result;
    }
    const reasonCode = result.ok
      ? "worker_admission_gate_allowed"
      : `worker_admission_${result.reason ?? "failed"}`.replaceAll("-", "_");
    workerAdmissionOrdinal += 1;
    void capability
      .run((identity) =>
        recordRuntimeActionDecision({
          token: identity.executionIdentityToken,
          family: "worker",
          operation: "admit",
          outcome: result.ok ? "allowed" : "denied",
          coverageState: "enforced",
          reasonCode,
          owner: "worker-runtime",
          decisionBoundary: "gateway.worker-admission",
          policyRefs: [
            "worker:credential",
            "worker:build",
            "worker:owner-epoch",
            "worker:turn-claim",
          ],
          summary: result.ok
            ? "The current worker credential, build, owner epoch, and turn claim passed admission."
            : "Worker admission was denied by the current credential, build, owner, or claim gate.",
          remediation: result.ok
            ? []
            : [
                {
                  code: "reprovision_worker",
                  text: "Redispatch the session so the worker receives the current build and credential binding.",
                },
              ],
          discriminator: JSON.stringify([
            admission.sessionId,
            admission.runId,
            admission.environmentId,
            admission.ownerEpoch,
            workerAdmissionReceiptScope,
            workerAdmissionOrdinal,
          ]),
        }),
      )
      // Diagnostic evidence must not revive or alter a worker admission whose owner closed.
      .catch(() => undefined);
    return result;
  };

  const matchesTurnBinding = (
    left: WorkerProcessTurnBinding,
    right: WorkerProcessTurnBinding,
  ): boolean =>
    sameWorkerSessionTurnClaim(left.turnClaim, right.turnClaim) &&
    safeEqualSecret(left.credentialHash, right.credentialHash);

  const recordAckCursor = (
    binding: WorkerProcessTurnBinding,
    cursor: { transcriptSeq: number } | { liveSeq: number },
  ): WorkerTerminalTurnFence => {
    const current = observedAckCursors.get(binding.turnClaim.sessionId);
    const currentTurn = current && matchesTurnBinding(current, binding) ? current : undefined;
    const next: WorkerTerminalTurnFence = {
      ...binding,
      transcriptSeq:
        "transcriptSeq" in cursor
          ? Math.max(currentTurn?.transcriptSeq ?? 0, cursor.transcriptSeq)
          : (currentTurn?.transcriptSeq ?? 0),
      liveSeq:
        "liveSeq" in cursor
          ? Math.max(currentTurn?.liveSeq ?? 0, cursor.liveSeq)
          : (currentTurn?.liveSeq ??
            options.placementStore?.readWorkerTurnLiveAckCursor(binding.turnClaim) ??
            0),
    };
    observedAckCursors.set(binding.turnClaim.sessionId, next);
    return next;
  };

  const observedAckCursorFor = (
    binding: WorkerProcessTurnBinding,
  ): WorkerTerminalTurnFence | undefined => {
    const observed = observedAckCursors.get(binding.turnClaim.sessionId);
    return observed && matchesTurnBinding(observed, binding) ? observed : undefined;
  };

  const validateWorkerPlacement = (
    identity: WorkerConnectionIdentity,
  ): WorkerPlacementValidation => {
    if (identity.sessionId === null && identity.runId === null) {
      return "sessionless";
    }
    if (!options.placementStore) {
      return "invalid";
    }
    const claim = placementClaim(identity);
    return claim && options.placementStore.validateWorkerTurn(claim) ? "durable" : "invalid";
  };

  const isTerminalLiveEvent = (request: WorkerLiveEventParams): boolean =>
    request.event.kind === "lifecycle" &&
    (request.event.payload.phase === "finishing" ||
      request.event.payload.phase === "end" ||
      (request.event.payload.phase === "error" &&
        (request.event.payload.aborted === true ||
          request.event.payload.fallbackExhaustedFailure === true)));

  const validateAttachedWorkerRequest = (
    identity: WorkerConnectionIdentity,
    runEpoch: number,
    request: WorkerTurnRequest,
    preparedPlacement?: WorkerPlacementValidation,
  ):
    | { ok: true }
    | { ok: false; closeReason: WorkerProtocolCloseReason }
    | { ok: false; reason: "epoch-mismatch" | "session-not-attached" } => {
    if (options.isStopping()) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    const placement =
      request.kind === "tool-surface"
        ? request.surface && getWorkerTurnToolSurface(identity) === request.surface
          ? "durable"
          : "invalid"
        : (preparedPlacement ?? validateWorkerPlacement(identity));
    if (placement === "invalid") {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    const turnBinding = processTurnBinding(identity);
    const terminalFence = identity.sessionId
      ? terminalTurnFences.get(identity.sessionId)
      : undefined;
    if (turnBinding && terminalFence && matchesTurnBinding(terminalFence, turnBinding)) {
      const isReplay =
        (request.kind === "transcript" && request.seq <= terminalFence.transcriptSeq) ||
        (request.kind === "live" && request.seq <= terminalFence.liveSeq);
      if (!isReplay) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
    }
    const credential = store.getCredential(identity.environmentId);
    if (!credential || !safeEqualSecret(credential.credentialHash, identity.credentialHash)) {
      return { ok: false, closeReason: "credential-replaced" };
    }
    // TTL limits unattached admission. An exact durable turn stays usable,
    // including reconnects, until its terminal ACK or placement fence.
    if (now() >= credential.expiresAtMs && placement !== "durable") {
      return { ok: false, closeReason: "credential-expired" };
    }
    const environment = store.get(identity.environmentId);
    if (!environment || environment.destroyRequestedAtMs !== null) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    if (
      runEpoch !== identity.ownerEpoch ||
      runEpoch !== credential.ownerEpoch ||
      runEpoch !== environment.ownerEpoch
    ) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    if (
      environment.state !== "attached" ||
      !identity.sessionId ||
      credential.sessionId !== identity.sessionId ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== identity.sessionId
    ) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (turnBinding && terminalFence && !matchesTurnBinding(terminalFence, turnBinding)) {
      // Credential rotation identifies a new process turn even when a caller
      // intentionally reuses its durable run id (for example, cron sessions).
      terminalTurnFences.delete(turnBinding.turnClaim.sessionId);
    }
    return { ok: true };
  };

  const commitTranscript = (
    identity: WorkerConnectionIdentity,
    request: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitServiceResult> =>
    withLock(identity.environmentId, async () => {
      const source = sourceFor(identity);
      if (!source) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
      const assertCurrent = (preparedPlacement?: WorkerPlacementValidation): undefined => {
        const binding = validateAttachedWorkerRequest(
          identity,
          request.runEpoch,
          { kind: "transcript", seq: request.seq },
          preparedPlacement,
        );
        if (!binding.ok) {
          throw new WorkerTranscriptAuthorityError(binding);
        }
        source.receiptAuthority();
      };
      try {
        assertCurrent();
        if (!options.applyTranscriptCommit) {
          return { ok: false, closeReason: "gateway-unavailable" };
        }
        const result = await options.applyTranscriptCommit({
          identity,
          request,
          sessionTarget: source.sessionTarget,
          assertCurrent,
        });
        // Persistence checks this owner after its queues and before commit; ACKs
        // also require the claim to remain live after post-commit publication.
        assertCurrent();
        // Stale base consumes a sequence just like success, including on replay.
        if (result.ok || result.reason === "stale-base-leaf") {
          const placement = placementClaim(identity);
          const processTurn = processTurnBinding(identity);
          if (!placement || !processTurn) {
            return { ok: false, closeReason: "placement-mismatch" };
          }
          await options.placementStore?.updateAckCursors({
            claim: placement,
            transcriptSeq: request.seq,
            // The ACK worker owns durable placement validation under its transaction.
            assertCurrent: () => assertCurrent("durable"),
          });
          assertCurrent();
          recordAckCursor(processTurn, { transcriptSeq: request.seq });
        }
        return result;
      } catch (error) {
        if (error instanceof WorkerTranscriptAuthorityError) {
          return error.outcome;
        }
        throw error;
      }
    });

  const executeComputer = createWorkerComputerRpc({
    execute: options.executeComputer,
    validate: (identity) => {
      const requestAdmission = validateAttachedWorkerRequest(identity, identity.ownerEpoch, {
        kind: "session-tool",
      });
      if (!requestAdmission.ok) {
        return "closeReason" in requestAdmission
          ? requestAdmission
          : { ok: false as const, closeReason: "placement-mismatch" as const };
      }
      const binding = placementClaim(identity);
      if (!binding || !options.placementStore?.isWorkerTurnToolAuthorized(binding, "computer")) {
        return { ok: false as const, closeReason: "method-not-allowed" as const };
      }
      return { ok: true as const };
    },
  });

  const withToolSurface = async <T>(
    identity: WorkerConnectionIdentity,
    run: (runtime: NonNullable<ReturnType<typeof getWorkerTurnToolSurface>>) => Promise<T> | T,
  ) => {
    const runtime = getWorkerTurnToolSurface(identity);
    const validate = () =>
      validateAttachedWorkerRequest(identity, identity.ownerEpoch, {
        kind: "tool-surface",
        surface: runtime,
      });
    const admitted = validate();
    if (!admitted.ok) {
      return "closeReason" in admitted
        ? admitted
        : { ok: false as const, closeReason: "placement-mismatch" as const };
    }
    if (!runtime) {
      return { ok: false as const, closeReason: "method-not-allowed" as const };
    }
    const result = await run(runtime);
    const current = validate();
    return current.ok
      ? { ok: true as const, result }
      : "closeReason" in current
        ? current
        : { ok: false as const, closeReason: "placement-mismatch" as const };
  };
  const getToolSurface = (identity: WorkerConnectionIdentity) =>
    withToolSurface(identity, (runtime) => runtime.getSurface(identity));
  const invokeGatewayTool = (
    identity: WorkerConnectionIdentity,
    request: WorkerGatewayToolInvokeParams,
    sink: WorkerGatewayToolSink,
    signal?: AbortSignal,
  ) =>
    withToolSurface(identity, (runtime) =>
      runtime.invoke(identity, request, sink, signal).catch(workerSessionToolErrorResult),
    );
  const cancelGatewayTool = (
    identity: WorkerConnectionIdentity,
    request: WorkerGatewayToolCancelParams,
  ) => withToolSurface(identity, (runtime) => runtime.cancel(request));

  const validateLiveEvent = (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
    preparedPlacement?: WorkerPlacementValidation,
  ): Exclude<WorkerLiveEventServiceResult, { ok: true }> | undefined => {
    const binding = validateAttachedWorkerRequest(
      identity,
      request.runEpoch,
      { kind: "live", seq: request.seq },
      preparedPlacement,
    );
    if (!binding.ok) {
      if ("closeReason" in binding) {
        return binding;
      }
      return { ok: false, details: { reason: binding.reason } };
    }
    if (request.runId !== identity.runId) {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    return undefined;
  };

  const pushLiveEvent = async (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ): Promise<WorkerLiveEventServiceResult> => {
    return await withLock(identity.environmentId, async () => {
      const invalid = validateLiveEvent(identity, request);
      if (invalid) {
        return invalid;
      }
      if (!options.liveEvents) {
        return { ok: false, closeReason: "gateway-unavailable" };
      }
      const source = sourceFor(identity);
      if (!source) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
      const placement = placementClaim(identity);
      const processTurn = processTurnBinding(identity);
      const placementStore = options.placementStore;
      if (!placement || !processTurn || !placementStore) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
      let durableAckedSeq: number | undefined;
      const readAckedSeq = () =>
        (durableAckedSeq ??= placementStore.readWorkerTurnLiveAckCursor(placement));
      const observed = observedAckCursorFor(processTurn);
      const wasNewSequence = request.seq > (observed?.liveSeq ?? readAckedSeq());
      // The environment lock owns trajectory settlement along with transcript
      // commits and terminal fences. Revocation remains immediate during this wait.
      const runOwner = captureWorkerTurnLiveEventOwner(identity);
      const result = await options.liveEvents.apply({ identity, request, source, readAckedSeq });
      const stale = validateLiveEvent(identity, request);
      if (stale) {
        return stale;
      }
      if (!result.ok) {
        if (result.details.reason === "resync-required") {
          // The receiver discarded its speculative suffix, including any buffered terminal.
          observedAckCursors.set(placement.sessionId, {
            ...processTurn,
            transcriptSeq: observed?.transcriptSeq ?? 0,
            liveSeq: result.details.ackedSeq,
          });
          pendingTerminalTurnFences.delete(placement.sessionId);
        }
        return result;
      }
      recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq });
      const pending = pendingTerminalTurnFences.get(placement.sessionId);
      if (pending && !matchesTurnBinding(pending, processTurn)) {
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      if (isTerminalLiveEvent(request) && wasNewSequence) {
        pendingTerminalTurnFences.set(placement.sessionId, {
          ...processTurn,
          terminalLiveSeq: request.seq,
        });
      }
      const terminal = pendingTerminalTurnFences.get(placement.sessionId);
      if (
        terminal &&
        matchesTurnBinding(terminal, processTurn) &&
        result.result.ackedSeq >= terminal.terminalLiveSeq
      ) {
        // Only finishing authority crosses the durable boundary. Its live cursor
        // and workspace-result recovery fence commit in one placement transaction.
        await placementStore.updateAckCursors({
          claim: placement,
          liveSeq: result.result.ackedSeq,
          assertCurrent: () => {
            const ackInvalid = validateLiveEvent(identity, request, "durable");
            if (ackInvalid) {
              throw new Error("Worker live event authority closed during ACK");
            }
            if (!runOwner?.isCancelledFinishing(request)) {
              source.receiptAuthority();
            }
          },
        });
        const staleAfterAck = validateLiveEvent(identity, request);
        if (staleAfterAck) {
          return staleAfterAck;
        }
        // Cancellation closes execution authority; only this captured owner may
        // finish its aborted receipt while the exact durable claim remains current.
        if (!runOwner?.isCancelledFinishing(request)) {
          source.receiptAuthority();
        }
        acknowledgeWorkerTurnFinishing(
          identity,
          result.result.ackedSeq,
          () => validateLiveEvent(identity, request) === undefined,
        );
        // A gap fill can ACK a previously buffered terminal event. Fence from
        // the observed high-water marks, not only from the request carrying it.
        terminalTurnFences.set(
          placement.sessionId,
          observedAckCursorFor(processTurn) ??
            recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq }),
        );
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      return result;
    });
  };

  const validateInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
  ) => {
    if (request.sessionId !== identity.sessionId || request.runId !== identity.runId) {
      return { ok: false, reason: "session-not-attached" } as const;
    }
    return validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
  };
  const revalidateInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
  ): "epoch-mismatch" | "session-not-attached" | null => {
    const binding = validateInference(identity, request);
    return binding.ok ? null : "reason" in binding ? binding.reason : "session-not-attached";
  };

  const startInference = async (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams,
    sink: WorkerInferenceSink,
  ): Promise<WorkerInferenceServiceResult<"start">> => {
    const binding = validateInference(identity, request);
    if (!binding.ok) {
      return binding;
    }
    const source = sourceFor(identity);
    if (!source) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (request.context.tools?.length) {
      const runtime = getWorkerTurnToolSurface(identity);
      if (!runtime) {
        return { ok: false, reason: "invalid-context" };
      }
      const surface = await runtime.getSurface(identity);
      source.receiptAuthority();
      const tools = surface.tools.map(({ definition: { name, description, parameters } }) => ({
        name,
        description,
        parameters,
      }));
      if (JSON.stringify(request.context.tools) !== JSON.stringify(tools)) {
        return { ok: false, reason: "invalid-context" };
      }
    }
    return inference.start({
      identity,
      request,
      sink,
      sessionTarget: source.sessionTarget,
      assertSourceCurrent: source.receiptAuthority,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  const cancelInference = async (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceCancelParams,
  ): Promise<WorkerInferenceServiceResult<"cancel">> => {
    const binding = validateInference(identity, request);
    if (!binding.ok) {
      return binding;
    }
    return inference.cancel({
      identity,
      request,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  return {
    admitWorker: async (admission: WorkerConnectParams["admission"]) => {
      const claim =
        admission.sessionId === null || admission.runId === null
          ? undefined
          : options.placementStore?.readWorkerTurnClaim({
              sessionId: admission.sessionId,
              environmentId: admission.environmentId,
              ownerEpoch: admission.ownerEpoch,
            });
      const capability =
        claim?.runId === admission.runId
          ? options.placementStore?.getExecutionIdentityCapability?.(claim)
          : undefined;
      const finish = <T extends { ok: boolean; reason?: string }>(result: T): T =>
        finishWorkerAdmission(admission, result, capability);
      if (options.isStopping()) {
        return finish({ ok: false, reason: "environment-unavailable" } as const);
      }
      const preflightAtMs = now();
      const preflight = admitWorkerAt(admission, admission.handshake, preflightAtMs);
      if (!preflight.ok) {
        return finish(preflight);
      }
      if (preflightAtMs >= preflight.identity.credentialExpiresAtMs) {
        const placement = placementClaim(preflight.identity);
        if (!placement || !options.placementStore?.validateWorkerTurn(placement)) {
          return finish({ ok: false, reason: "credential-expired" } as const);
        }
      }
      let expectedBuild: ExpectedWorkerBuild;
      try {
        expectedBuild = await options.prepareInstallation("bundle");
      } catch {
        return finish({ ok: false, reason: "environment-unavailable" } as const);
      }
      if (options.isStopping()) {
        return finish({ ok: false, reason: "environment-unavailable" } as const);
      }
      const admittedAtMs = now();
      const admitted = admitWorkerAt(admission, expectedBuild, admittedAtMs);
      if (!admitted.ok) {
        return finish(admitted);
      }
      const expired = admittedAtMs >= admitted.identity.credentialExpiresAtMs;
      if (
        !options.placementStore ||
        (admitted.identity.sessionId === null && admitted.identity.runId === null)
      ) {
        return finish(expired ? ({ ok: false, reason: "credential-expired" } as const) : admitted);
      }
      const placement = placementClaim(admitted.identity);
      if (!placement || !options.placementStore.validateWorkerTurn(placement)) {
        return finish({
          ok: false,
          reason: expired ? "credential-expired" : "placement-mismatch",
        } as const);
      }
      return finish(admitted);
    },
    validateWorkerConnection: (
      identity: WorkerConnectionIdentity,
      request?: { toolSurface: true },
    ) => {
      if (options.isStopping()) {
        return "environment-unavailable" as const;
      }
      const placement = request?.toolSurface
        ? getWorkerTurnToolSurface(identity)
          ? "durable"
          : "invalid"
        : validateWorkerPlacement(identity);
      if (placement === "invalid") {
        return "placement-mismatch" as const;
      }
      const environmentFailure = validateWorkerConnectionIdentity({
        store,
        identity,
        nowMs: now(),
      });
      if (
        environmentFailure &&
        !(environmentFailure === "credential-expired" && placement === "durable")
      ) {
        return environmentFailure;
      }
      return null;
    },
    commitTranscript,
    pushLiveEvent,
    getToolSurface,
    invokeGatewayTool,
    cancelGatewayTool,
    executeComputer,
    startInference,
    cancelInference,
    clear: () => {
      observedAckCursors.clear();
      pendingTerminalTurnFences.clear();
      terminalTurnFences.clear();
    },
  };
}
