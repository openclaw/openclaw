import {
  type RequestFrame,
  type WorkerConnectParams,
  type WorkerErrorShape,
  type WorkerHeartbeatResult,
  type WorkerLiveEventErrorShape,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorShape,
  WORKER_COMPUTER_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_METHODS,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  validateWorkerComputerParams,
  validateWorkerHeartbeatParams,
  validateWorkerLiveEventParams,
  validateWorkerPortalParams,
  validateWorkerSessionsSendParams,
  validateWorkerSessionsSpawnParams,
  validateWorkerTranscriptCommitParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  type WorkerInferenceErrorShape,
  WORKER_INFERENCE_METHODS,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceCancelParams,
  validateWorkerInferenceStartParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WORKER_SKILL_WORKSHOP_FEATURE,
  validateWorkerSkillWorkshopParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { createWorkerTurnRpc } from "../../worker-environments/worker-turn-rpc.js";
import {
  workerInferenceError,
  workerLiveEventError,
  workerProtocolError,
  workerTranscriptCommitError,
} from "./worker-connection-frames.js";

type WorkerServiceResult<TFailure extends { ok: false }> =
  | { ok: true; result: unknown }
  | TFailure
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerTurnRpc = ReturnType<typeof createWorkerTurnRpc>;
type WorkerServiceFailure<K extends keyof WorkerTurnRpc> = Exclude<
  Awaited<ReturnType<WorkerTurnRpc[K]>>,
  { ok: true } | { closeReason: WorkerProtocolCloseReason }
>;
export type WorkerConnectionService = Pick<
  WorkerTurnRpc,
  "commitTranscript" | "pushLiveEvent" | "validateWorkerConnection"
> &
  Partial<Pick<WorkerTurnRpc, "executeComputer" | "executeSessionTool">> & {
    admitWorker: (
      admission: WorkerConnectParams["admission"],
    ) => Promise<
      | { ok: true; identity: WorkerConnectionIdentity }
      | { ok: false; reason: WorkerProtocolCloseReason }
    >;
  };

type WorkerInferenceConnectionService = WorkerConnectionService &
  Partial<Pick<WorkerTurnRpc, "startInference" | "cancelInference">>;

const SESSION_TOOL_REQUESTS = [
  [
    "worker.sessions.spawn",
    "sessions_spawn",
    WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
    validateWorkerSessionsSpawnParams,
  ],
  [
    "worker.sessions.send",
    "sessions_send",
    WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
    validateWorkerSessionsSendParams,
  ],
  ["worker.portal", "portal", WORKER_PORTAL_PROTOCOL_FEATURE, validateWorkerPortalParams],
  [
    "worker.skill-workshop",
    "skill_workshop",
    WORKER_SKILL_WORKSHOP_FEATURE,
    validateWorkerSkillWorkshopParams,
  ],
] as const;

type WorkerRespond = (
  ok: boolean,
  payload?: unknown,
  error?:
    | WorkerErrorShape
    | WorkerInferenceErrorShape
    | WorkerLiveEventErrorShape
    | WorkerTranscriptCommitErrorShape,
) => void;

function rejectWorkerRequest(params: {
  reason: WorkerProtocolCloseReason;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
}): void {
  params.warn(`worker protocol request rejected reason=${params.reason}`);
  params.respond(false, undefined, workerProtocolError(params.reason));
  queueMicrotask(() => params.close(1008, params.reason));
}

/** Closed worker dispatcher. It never calls the generic gateway method registry. */
export async function dispatchWorkerRequest(params: {
  request: RequestFrame;
  identity: WorkerConnectionIdentity;
  connectionId: string;
  service: WorkerInferenceConnectionService | undefined;
  send(frame: unknown): void;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
  signal?: AbortSignal;
}): Promise<void> {
  const service = params.service;
  if (!service) {
    rejectWorkerRequest({ ...params, reason: "environment-unavailable" });
    return;
  }
  const ownershipFailure = service.validateWorkerConnection(params.identity);
  if (ownershipFailure) {
    rejectWorkerRequest({ ...params, reason: ownershipFailure });
    return;
  }
  const respondOutcome = <TFailure extends { ok: false }>(
    outcome: WorkerServiceResult<TFailure>,
    errorFor: (failure: TFailure) => Parameters<WorkerRespond>[2],
  ): void => {
    if (outcome.ok) {
      params.respond(true, outcome.result);
    } else if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
    } else {
      params.respond(false, undefined, errorFor(outcome));
    }
  };
  const execute = async <TRequest, TFailure extends { ok: false }>(
    feature: string,
    validate: (value: unknown) => value is TRequest,
    operation: ((request: TRequest) => Promise<WorkerServiceResult<TFailure>>) | undefined,
    invalid: NonNullable<Parameters<WorkerRespond>[2]> | WorkerProtocolCloseReason,
    errorFor: (failure: TFailure) => Parameters<WorkerRespond>[2],
  ): Promise<void> => {
    if (!params.identity.protocolFeatures.includes(feature) || !operation) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
    } else if (!validate(params.request.params)) {
      if (typeof invalid === "string") {
        rejectWorkerRequest({ ...params, reason: invalid });
      } else {
        params.respond(false, undefined, invalid);
      }
    } else {
      respondOutcome(await operation(params.request.params), errorFor);
    }
  };
  if (params.request.method === WORKER_INFERENCE_METHODS[0]) {
    if (!params.identity.protocolFeatures.includes(WORKER_INFERENCE_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerInferenceStartParams(params.request.params)) {
      params.respond(false, undefined, workerInferenceError("invalid-context"));
      return;
    }
    if (!service.startInference) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const outcome = service.startInference(params.identity, params.request.params, {
      connectionId: params.connectionId,
      send: (frame) => params.send(frame),
    });
    // Reply before a synchronous provider can emit.
    respondOutcome(outcome, (failure: WorkerServiceFailure<"startInference">) =>
      workerInferenceError(failure.reason),
    );
    if (outcome.ok) {
      outcome.launch();
    }
    return;
  }
  if (params.request.method === WORKER_INFERENCE_METHODS[1]) {
    if (!params.identity.protocolFeatures.includes(WORKER_INFERENCE_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerInferenceCancelParams(params.request.params)) {
      params.respond(false, undefined, workerInferenceError("invalid-context"));
      return;
    }
    if (!service.cancelInference) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const outcome = service.cancelInference(params.identity, params.request.params);
    respondOutcome(outcome, (failure: WorkerServiceFailure<"cancelInference">) =>
      workerInferenceError(failure.reason),
    );
    return;
  }
  if (params.request.method === WORKER_PROTOCOL_METHODS[1]) {
    return execute(
      WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
      validateWorkerTranscriptCommitParams,
      (request) => service.commitTranscript(params.identity, request),
      workerTranscriptCommitError("invalid-batch"),
      (failure: WorkerServiceFailure<"commitTranscript">) =>
        workerTranscriptCommitError(failure.reason),
    );
  }
  if (params.request.method === WORKER_PROTOCOL_METHODS[2]) {
    return execute(
      WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
      validateWorkerLiveEventParams,
      (request) => service.pushLiveEvent(params.identity, request),
      workerLiveEventError({ reason: "invalid-event" }),
      (failure: WorkerServiceFailure<"pushLiveEvent">) => workerLiveEventError(failure.details),
    );
  }
  if (params.request.method === "worker.computer") {
    const operation = service.executeComputer;
    return execute(
      WORKER_COMPUTER_PROTOCOL_FEATURE,
      validateWorkerComputerParams,
      operation && ((request) => operation.call(service, params.identity, request, params.signal)),
      "invalid-frame",
      (failure: WorkerServiceFailure<"executeComputer">) =>
        workerProtocolError(failure.reason, { message: failure.message }),
    );
  }
  const sessionTool = SESSION_TOOL_REQUESTS.find(([method]) => method === params.request.method);
  if (sessionTool) {
    const [, toolName, feature, validate] = sessionTool;
    const operation = service.executeSessionTool;
    return execute(
      feature,
      validate,
      operation &&
        ((request: Parameters<WorkerTurnRpc["executeSessionTool"]>[2]) =>
          operation.call(service, params.identity, toolName, request, params.signal)),
      workerProtocolError("invalid-frame"),
      (failure: WorkerServiceFailure<"executeSessionTool">) => workerProtocolError(failure.reason),
    );
  }
  if (params.request.method !== WORKER_PROTOCOL_METHODS[0]) {
    rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
    return;
  }
  if (!validateWorkerHeartbeatParams(params.request.params)) {
    rejectWorkerRequest({ ...params, reason: "invalid-heartbeat" });
    return;
  }
  const result: WorkerHeartbeatResult = {
    receivedAtMs: Date.now(),
    status: "ok",
    ownerEpoch: params.identity.ownerEpoch,
  };
  params.respond(true, result);
}
