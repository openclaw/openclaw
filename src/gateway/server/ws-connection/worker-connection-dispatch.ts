import {
  type RequestFrame,
  type WorkerErrorShape,
  type WorkerHeartbeatResult,
  type WorkerLiveEventErrorShape,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorShape,
  WORKER_COMPUTER_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_METHODS,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  validateWorkerComputerParams,
  validateWorkerHeartbeatParams,
  validateWorkerLiveEventParams,
  validateWorkerTranscriptCommitParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  WORKER_GATEWAY_TOOL_METHODS,
  validateWorkerGatewayToolInvokeParams,
  validateWorkerGatewayToolCancelParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  type WorkerInferenceErrorShape,
  WORKER_INFERENCE_METHODS,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceCancelParams,
  validateWorkerInferenceStartParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { createWorkerTurnRpc } from "../../worker-environments/worker-turn-rpc.js";
import {
  workerInferenceError,
  workerLiveEventError,
  workerProtocolError,
  workerTranscriptCommitError,
} from "./worker-connection-frames.js";

type WorkerServiceResult<TFailure extends { ok: false }> =
  | { ok: true; result: unknown; launch?: () => void }
  | TFailure
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerTurnRpc = ReturnType<typeof createWorkerTurnRpc>;
type WorkerServiceFailure<K extends keyof WorkerTurnRpc> = Exclude<
  Awaited<ReturnType<WorkerTurnRpc[K]>>,
  { ok: true } | { closeReason: WorkerProtocolCloseReason }
>;
export type WorkerConnectionService = Pick<
  WorkerTurnRpc,
  "admitWorker" | "commitTranscript" | "pushLiveEvent" | "validateWorkerConnection"
> &
  Partial<
    Pick<
      WorkerTurnRpc,
      | "executeComputer"
      | "getToolSurface"
      | "invokeGatewayTool"
      | "cancelGatewayTool"
      | "startInference"
      | "cancelInference"
      | "refreshGitHubBinding"
    >
  >;

type WorkerRespond = (
  ok: boolean,
  payload?: unknown,
  error?:
    | WorkerErrorShape
    | WorkerInferenceErrorShape
    | WorkerLiveEventErrorShape
    | WorkerTranscriptCommitErrorShape,
) => void;

/** Closed worker dispatcher. It never calls the generic gateway method registry. */
export async function dispatchWorkerRequest(params: {
  request: RequestFrame;
  identity: WorkerConnectionIdentity;
  connectionId: string;
  service: WorkerConnectionService | undefined;
  send(frame: unknown): void;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
  signal?: AbortSignal;
}): Promise<void> {
  const reject = (reason: WorkerProtocolCloseReason) => {
    params.warn(`worker protocol request rejected reason=${reason}`);
    params.respond(false, undefined, workerProtocolError(reason));
    queueMicrotask(() => params.close(1008, reason));
  };
  const service = params.service;
  if (!service) {
    reject("environment-unavailable");
    return;
  }
  const toolSurfaceRequest = Object.values(WORKER_GATEWAY_TOOL_METHODS).some(
    (method) => method === params.request.method,
  );
  const ownershipFailure = toolSurfaceRequest
    ? service.validateWorkerConnection(params.identity, { toolSurface: true })
    : service.validateWorkerConnection(params.identity);
  if (ownershipFailure) {
    reject(ownershipFailure);
    return;
  }
  const execute = async <TRequest, TFailure extends { ok: false }>(
    feature: string,
    validate: (value: unknown) => value is TRequest,
    operation: ((request: TRequest) => Promise<WorkerServiceResult<TFailure>>) | undefined,
    invalid: NonNullable<Parameters<WorkerRespond>[2]> | WorkerProtocolCloseReason,
    errorFor: (failure: TFailure) => Parameters<WorkerRespond>[2],
  ): Promise<void> => {
    if (!params.identity.protocolFeatures.includes(feature) || !operation) {
      reject("method-not-allowed");
    } else if (!validate(params.request.params)) {
      if (typeof invalid === "string") {
        reject(invalid);
      } else {
        params.respond(false, undefined, invalid);
      }
    } else {
      const outcome = await operation(params.request.params);
      if (outcome.ok) {
        params.respond(true, outcome.result);
        // Reply before a synchronous provider can emit.
        outcome.launch?.();
      } else if ("closeReason" in outcome) {
        reject(outcome.closeReason);
      } else {
        params.respond(false, undefined, errorFor(outcome));
      }
    }
  };
  // Inference validates its context before rejecting an unavailable handler.
  const unavailableInference = async () => ({
    ok: false as const,
    closeReason: "method-not-allowed" as const,
  });
  if (params.request.method === WORKER_GATEWAY_TOOL_METHODS.invoke) {
    const operation = service.invokeGatewayTool;
    return execute(
      WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
      validateWorkerGatewayToolInvokeParams,
      operation &&
        ((request) => operation.call(service, params.identity, request, params, params.signal)),
      "invalid-frame",
      () => workerProtocolError("gateway-unavailable"),
    );
  }
  if (params.request.method === WORKER_GATEWAY_TOOL_METHODS.cancel) {
    const operation = service.cancelGatewayTool;
    return execute(
      WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
      validateWorkerGatewayToolCancelParams,
      operation && ((request) => operation.call(service, params.identity, request)),
      "invalid-frame",
      () => workerProtocolError("gateway-unavailable"),
    );
  }
  if (params.request.method === WORKER_INFERENCE_METHODS[0]) {
    const operation = service.startInference;
    return execute(
      WORKER_INFERENCE_PROTOCOL_FEATURE,
      validateWorkerInferenceStartParams,
      operation
        ? (request) => operation.call(service, params.identity, request, params)
        : unavailableInference,
      workerInferenceError("invalid-context"),
      (failure: WorkerServiceFailure<"startInference">) => workerInferenceError(failure.reason),
    );
  }
  if (params.request.method === WORKER_INFERENCE_METHODS[1]) {
    const operation = service.cancelInference;
    return execute(
      WORKER_INFERENCE_PROTOCOL_FEATURE,
      validateWorkerInferenceCancelParams,
      operation
        ? (request) => operation.call(service, params.identity, request)
        : unavailableInference,
      workerInferenceError("invalid-context"),
      (failure: WorkerServiceFailure<"cancelInference">) => workerInferenceError(failure.reason),
    );
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
  if (params.request.method !== WORKER_PROTOCOL_METHODS[0]) {
    reject("method-not-allowed");
    return;
  }
  if (!validateWorkerHeartbeatParams(params.request.params)) {
    reject("invalid-heartbeat");
    return;
  }
  let github: WorkerHeartbeatResult["github"];
  if (
    params.request.params.githubGeneration !== undefined &&
    params.identity.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE) &&
    service.refreshGitHubBinding
  ) {
    const refreshed = await service.refreshGitHubBinding(
      params.identity,
      params.request.params.githubGeneration,
    );
    if (!refreshed.ok) {
      reject(refreshed.closeReason);
      return;
    }
    const currentFailure = service.validateWorkerConnection(params.identity);
    if (params.signal?.aborted || currentFailure) {
      reject(currentFailure ?? "placement-mismatch");
      return;
    }
    if (refreshed.result) {
      refreshed.assertCurrent();
    }
    github = refreshed.result;
  } else if (params.request.params.githubGeneration !== undefined) {
    reject("invalid-heartbeat");
    return;
  }
  const result: WorkerHeartbeatResult = {
    receivedAtMs: Date.now(),
    status: "ok",
    ownerEpoch: params.identity.ownerEpoch,
    ...(github ? { github } : {}),
  };
  params.respond(true, result);
}
