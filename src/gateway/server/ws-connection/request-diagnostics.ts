import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SESSION_LIST_SOURCES } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { WORKER_PROTOCOL_METHODS } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_INFERENCE_METHODS } from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { hasInternalDiagnosticEventInterest } from "../../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { runWithMainThreadTask } from "../../../infra/main-thread-stall.js";
import { isCoreGatewayMethodClassified } from "../../methods/core-method-policy.js";
import type { GatewayMethodRegistry } from "../../methods/registry.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import {
  getSessionListBaseMiss,
  retainSessionListBaseMiss,
} from "../../session-list-diagnostics.js";

type RpcEvent = Extract<DiagnosticEventInput, { type: "gateway.rpc" }>;
type ResponseOutcome = Extract<RpcEvent, { phase: "response" }>["outcome"];
type DispatchOutcome = Extract<RpcEvent, { phase: "dispatch" }>["outcome"];
type ModelsListAttribution = Extract<RpcEvent, { phase: "received" }>["modelsList"];
type SessionsListAttribution = Extract<RpcEvent, { phase: "received" }>["sessionsList"];
type CronListAttribution = Extract<RpcEvent, { phase: "received" }>["cronList"];
type ChatHistoryAttribution = NonNullable<Extract<RpcEvent, { phase: "response" }>["chatHistory"]>;
const workerMethods = new Set<string>([...WORKER_PROTOCOL_METHODS, ...WORKER_INFERENCE_METHODS]);
const rpcDiagnostics = channel("openclaw.gateway.rpc");
let activeHandlers = 0;
let exclusiveHandler: GatewayRpcDiagnostics | undefined;
const sharedResponseFields = new WeakMap<
  object,
  { rowsUnchanged: boolean; rowsDelta: true | undefined }
>();

/** Retain only bounded diagnostic facts for the lifetime of the encoded response. */
export function retainGatewayRpcResponseDiagnostics(
  method: string,
  payload: unknown,
  serialized: object,
): void {
  if (method !== "sessions.list") {
    return;
  }
  const result = asOptionalRecord(payload);
  if (result) {
    retainSessionListBaseMiss(serialized, getSessionListBaseMiss(result));
    sharedResponseFields.set(serialized, {
      rowsUnchanged: result.rowsUnchanged === true,
      rowsDelta: result.rowsDelta === undefined ? undefined : true,
    });
  }
}

export type GatewayRpcQueueTiming = { receivedAt: number; dequeuedAt: number };

export class GatewayRpcDiagnostics {
  private trace = getActiveDiagnosticTraceContext();
  private queueStartedAt?: number;
  private queueWaitMs?: number;
  private handlerStarted = false;
  private deliveryFailureRecorded = false;
  private dispatchFinished = false;
  private responseState: Extract<RpcEvent, { phase: "dispatch" }>["response"] = "none";

  constructor(
    private readonly method: string,
    clientKind: Extract<RpcEvent, { phase: "received" }>["clientKind"],
    private readonly startedAt = performance.now(),
    queueWaitMs?: number,
    modelsList?: ModelsListAttribution,
    private readonly sessionsList?: SessionsListAttribution,
    cronList?: CronListAttribution,
    private readonly chatHistoryClient?: Pick<ChatHistoryAttribution, "clientKind" | "source">,
  ) {
    this.queueWaitMs = queueWaitMs;
    this.emit({
      type: "gateway.rpc",
      method,
      phase: "received",
      clientKind,
      ...(modelsList && { modelsList }),
      ...(sessionsList && { sessionsList }),
      ...(cronList && { cronList }),
    });
  }

  private emit(event: RpcEvent): void {
    if (rpcDiagnostics.hasSubscribers) {
      rpcDiagnostics.publish({ ...event, operation: `${event.method}.${event.phase}` });
    }
    // A retained response can run under another request; preserve captured absence too.
    runWithDiagnosticTraceContext(this.trace, () => emitTrustedDiagnosticEvent(event));
  }

  bindTrace(trace = getActiveDiagnosticTraceContext()): void {
    this.trace = trace;
  }

  startQueue(): void {
    this.queueStartedAt = performance.now();
  }

  finishQueue(): void {
    if (this.queueStartedAt !== undefined) {
      this.queueWaitMs = performance.now() - this.queueStartedAt;
    }
  }

  response(
    outcome: ResponseOutcome,
    responseBytes?: number,
    response?: { payload: unknown; params: unknown },
  ): void {
    const sent = outcome === "ok" || outcome === "error";
    const firstResponse = this.responseState !== "sent";
    if (sent ? !firstResponse && responseBytes === undefined : this.deliveryFailureRecorded) {
      return;
    }
    if (sent) {
      this.responseState = "sent";
    } else {
      this.deliveryFailureRecorded = true;
      if (this.responseState !== "sent") {
        this.responseState = outcome;
      }
    }
    // Acceptance and final frames can share one request and outlive its handler.
    // Keep first-response timing separate from each encoded frame's byte count.
    // Successful replies have passed method validation; never attribute rejected params.
    let result =
      outcome === "ok" && (this.sessionsList || this.chatHistoryClient)
        ? asOptionalRecord(response?.payload)
        : undefined;
    const baseMissReason = result ? getSessionListBaseMiss(result) : undefined;
    if (result) {
      result = sharedResponseFields.get(result) ?? result;
    }
    const params = result ? asOptionalRecord(response?.params) : undefined;
    let chatHistory: ChatHistoryAttribution | undefined;
    if (this.chatHistoryClient && result && response) {
      const limit = typeof params?.limit === "number" ? params.limit : 200;
      chatHistory = {
        ...this.chatHistoryClient,
        shape:
          params?.inputRunIds !== undefined
            ? "receipt"
            : params?.pendingBefore !== undefined
              ? "pending"
              : typeof params?.offset === "number" && params.offset > 0
                ? "older"
                : params?.cursor !== undefined
                  ? "cursor"
                  : params?.messageId !== undefined
                    ? "anchor"
                    : "tail",
        limitBucket: limit <= 20 ? "<=20" : limit <= 80 ? "<=80" : limit <= 200 ? "<=200" : ">200",
        outcome: result.kind === "delta" ? "delta" : result.kind === "reset" ? "reset" : "page",
      };
    }
    const rowsOutcome =
      this.sessionsList?.rowMode !== "sidebar" && params?.ifRowsRevision === undefined
        ? "not-sidebar"
        : result?.rowsUnchanged === true
          ? "unchanged"
          : result?.rowsDelta !== undefined
            ? "delta"
            : params?.ifRowsRevision === undefined || params.ifRowsRevision === ""
              ? "full-no-base"
              : "full-with-base";
    this.emit({
      type: "gateway.rpc",
      method: this.method,
      phase: "response",
      outcome,
      firstResponse: sent ? firstResponse : undefined,
      responseBytes,
      ...(this.sessionsList && result
        ? {
            sessionsList: {
              ...this.sessionsList,
              rowsOutcome,
              ...(rowsOutcome === "full-with-base" && baseMissReason ? { baseMissReason } : {}),
            },
          }
        : {}),
      ...(chatHistory ? { chatHistory } : {}),
      durationMs: performance.now() - this.startedAt,
    });
  }

  static async runHandler(
    method: string,
    invoke: () => Promise<void> | void,
    diagnostics?: GatewayRpcDiagnostics,
  ): Promise<void> {
    // All handler entries participate, including in-process calls without diagnostics.
    // Another start permanently invalidates the sole candidate until all handlers settle.
    exclusiveHandler = ++activeHandlers === 1 ? diagnostics : undefined;
    const heapUsedAtStart =
      diagnostics && exclusiveHandler === diagnostics && isMainThread
        ? process.memoryUsage().heapUsed
        : undefined;
    const startedAt = diagnostics ? performance.now() : 0;
    if (diagnostics) {
      diagnostics.handlerStarted = true;
    }
    let outcome: "returned" | "threw" = "returned";
    try {
      await runWithMainThreadTask(`gateway:rpc:${method}`, invoke);
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      const heapDeltaBytes =
        heapUsedAtStart !== undefined && exclusiveHandler === diagnostics
          ? process.memoryUsage().heapUsed - heapUsedAtStart
          : undefined;
      activeHandlers--;
      exclusiveHandler = undefined;
      diagnostics?.emit({
        type: "gateway.rpc",
        method: diagnostics.method,
        phase: "handler",
        outcome,
        durationMs: performance.now() - startedAt,
        admissionMs: startedAt - diagnostics.startedAt,
        heapDeltaBytes,
      });
    }
  }

  finish(outcome: DispatchOutcome): void {
    if (this.dispatchFinished) {
      return;
    }
    this.dispatchFinished = true;
    this.emit({
      type: "gateway.rpc",
      method: this.method,
      phase: "dispatch",
      outcome: outcome === "returned" && !this.handlerStarted ? "rejected" : outcome,
      durationMs: performance.now() - this.startedAt,
      ...(this.queueWaitMs !== undefined ? { queueWaitMs: this.queueWaitMs } : {}),
      response: this.responseState,
    });
  }
}

/** Capture receipt before a socket FIFO, without work when diagnostics are unused. */
export function captureGatewayRpcReceivedAt(): number | undefined {
  return rpcDiagnostics.hasSubscribers ||
    (areDiagnosticsEnabledForProcess() && hasInternalDiagnosticEventInterest("gateway.rpc", true))
    ? performance.now()
    : undefined;
}

export function createWorkerRpcDiagnostics(
  method: string,
  timing: GatewayRpcQueueTiming | undefined,
): GatewayRpcDiagnostics | undefined {
  if (!timing) {
    return undefined;
  }
  // Dedicated worker ingress bypasses the generic registry. Never let a caller's
  // unknown method become an unbounded metric dimension.
  return new GatewayRpcDiagnostics(
    workerMethods.has(method) ? method : "unknown",
    "node",
    timing.receivedAt,
    timing.dequeuedAt - timing.receivedAt,
  );
}

export function createGatewayRpcDiagnostics(
  method: string,
  getMethodRegistry: (() => GatewayMethodRegistry) | undefined,
  extraHandlers: GatewayRequestHandlers,
  listRequest?: {
    clientKind: NonNullable<ModelsListAttribution>["clientKind"];
    source: NonNullable<ModelsListAttribution>["source"];
    params: unknown;
  },
): GatewayRpcDiagnostics | undefined {
  if (
    !rpcDiagnostics.hasSubscribers &&
    (!areDiagnosticsEnabledForProcess() || !hasInternalDiagnosticEventInterest("gateway.rpc", true))
  ) {
    return undefined;
  }
  // Only catalog-owned names become dimensions, never arbitrary request values.
  const label =
    isCoreGatewayMethodClassified(method) ||
    getMethodRegistry?.().getHandler(method) ||
    Object.hasOwn(extraHandlers, method)
      ? method
      : "other";
  let modelsList: ModelsListAttribution;
  if (method === "models.list" && listRequest) {
    // Only the frame has been validated here; reduce method params to bounded shape facts.
    const params = asOptionalRecord(listRequest.params);
    const view = params?.view;
    modelsList = {
      clientKind: listRequest.clientKind,
      source: listRequest.source,
      view:
        view === undefined || view === "default"
          ? "default"
          : view === "configured" || view === "provider-config" || view === "all"
            ? view
            : "other",
      scope:
        params?.sessionKey !== undefined
          ? "session"
          : params?.authProfileId !== undefined
            ? "auth-profile"
            : params?.agentId !== undefined
              ? "agent"
              : "global",
      refresh: params?.refresh === true,
      preparedOnly: params?.preparedOnly === true,
    };
  }
  let sessionsList: SessionsListAttribution;
  if (method === "sessions.list" && listRequest) {
    const params = asOptionalRecord(listRequest.params);
    const rowMode = params?.rowMode;
    sessionsList = {
      clientKind: listRequest.clientKind,
      source: listRequest.source,
      callerSource:
        SESSION_LIST_SOURCES.find((source) => source === params?.source) ?? "unspecified",
      rowMode:
        rowMode === undefined
          ? "full"
          : rowMode === "compact" || rowMode === "dashboard" || rowMode === "sidebar"
            ? rowMode
            : "other",
      filter:
        params?.search !== undefined
          ? "search"
          : params?.spawnedBy !== undefined
            ? "children"
            : params?.ownerId !== undefined
              ? "owner"
              : params?.involvingMe === true ||
                  params?.involvingProfileId !== undefined ||
                  params?.profileRelation !== undefined
                ? "involving"
                : params?.activeOnly === true || params?.activeMinutes !== undefined
                  ? "active"
                  : "general",
    };
  }
  let cronList: CronListAttribution;
  if (method === "cron.list" && listRequest) {
    const params = asOptionalRecord(listRequest.params);
    cronList = {
      clientKind: listRequest.clientKind,
      source: listRequest.source,
      scope:
        params?.sessionKey !== undefined
          ? "session"
          : params?.agentId !== undefined
            ? "agent"
            : "global",
      compact: params?.compact === true,
      page: typeof params?.offset === "number" && params.offset > 0 ? "append" : "first",
    };
  }
  return new GatewayRpcDiagnostics(
    label,
    rpcClientKind(listRequest?.clientKind),
    undefined,
    undefined,
    modelsList,
    sessionsList,
    cronList,
    method === "chat.history" && listRequest
      ? { clientKind: listRequest.clientKind, source: listRequest.source }
      : undefined,
  );
}

function rpcClientKind(
  id: NonNullable<ModelsListAttribution>["clientKind"] | undefined,
): NonNullable<Extract<RpcEvent, { phase: "received" }>["clientKind"]> {
  switch (id) {
    case "openclaw-control-ui":
    case "webchat-ui":
    case "webchat":
    case "openclaw-browser-copilot":
      return "control-ui";
    case "openclaw-macos":
      return "macos";
    case "openclaw-ios":
    case "openclaw-watchos":
      return "ios";
    case "openclaw-android":
      return "android";
    case "cli":
    case "openclaw-tui":
      return "cli";
    case "node-host":
    case "openclaw-worker":
      return "node";
    default:
      // Generic gateway clients and scoped plugin calls do not identify a plugin.
      return "other";
  }
}
