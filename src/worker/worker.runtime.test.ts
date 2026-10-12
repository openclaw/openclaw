import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { validateWorkerComputerParams } from "../../packages/gateway-protocol/src/index.js";
import {
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerHeartbeatRequestFrame,
  WorkerHeartbeatRequestFrameSchema,
  type WorkerLiveEventParams,
  type WorkerLiveEventRequestFrame,
  WorkerLiveEventRequestFrameSchema,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptCommitRequestFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerComputerParams } from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  validateWorkerGatewayToolInvokeParams,
  type WorkerGatewayToolInvokeParams,
  type WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  type WorkerInferenceCancelRequestFrame,
  WorkerInferenceCancelRequestFrameSchema,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartRequestFrame,
  WorkerInferenceStartRequestFrameSchema,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { listRunningSessions, waitForExecScope } from "../agents/bash-process-registry.js";
import { runExecProcess } from "../agents/bash-tools.exec-runtime.js";
import { hasModelFallbackStop } from "../agents/failover-error.js";
import { prepareCoreToolPolicy } from "../agents/prepared-tool-surface.js";
import * as agentSessionSdk from "../agents/sessions/sdk.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import * as workerTranscriptRuntime from "./embedded-agent-transcript.runtime.js";
import {
  buildWorkerConnectParams,
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { WorkerAdmissionDeadlineExceededError } from "./worker-connection-contract.js";
import { createWorkerConnection, type WorkerConnectionState } from "./worker-connection.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";
import { WorkerLiveEventClient } from "./worker-rpc-live-event-client.js";
import { WorkerTranscriptCommitClient } from "./worker-rpc-transcript-client.js";
import {
  registerWorkerBackgroundExecLifecycleTests,
  registerWorkerExecEnvironmentFinalizationTests,
} from "./worker-runtime-background-exec.suite.js";
import {
  registerWorkerGatewayToolAvailabilityTests,
  registerWorkerGatewayToolRpcTests,
} from "./worker-runtime-gateway-tools.suite.js";
import { registerWorkerGitHubTests } from "./worker-runtime-github.suite.js";
import { registerWorkerNativeInferenceTests } from "./worker-runtime-native-inference.suite.js";
import { registerWorkerPermissionTests } from "./worker-runtime-permissions.suite.js";
import { registerWorkerPromptTests } from "./worker-runtime-prompt.suite.js";
import { registerWorkerReplayWindowTests } from "./worker-runtime-replay.suite.js";
import { createWorkerToolSurfaceForTest } from "./worker-tool-surface.test-support.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

const browserRuntimeMocks = vi.hoisted(() => ({
  createWorkerBrowserToolRuntime: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("./browser-runtime.js", () => {
  browserRuntimeMocks.createWorkerBrowserToolRuntime.mockImplementation(async () => ({
    tool: {
      name: "browser",
      label: "Browser",
      description: "Control the attached worker browser.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    dispose: browserRuntimeMocks.dispose,
  }));
  return { createWorkerBrowserToolRuntime: browserRuntimeMocks.createWorkerBrowserToolRuntime };
});

// Compile the real lazy runtimes during collection, not inside the first turn.
// Cold imports must not consume these integration cases' lifecycle deadlines.
await Promise.all([import("./embedded-agent.runtime.js"), import("../agents/bash-tools.js")]);

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const SESSION_ID = "worker-session";
const RUN_ID = "worker-run";
const OWNER_EPOCH = 4;
const MODEL_REF = { provider: "openai", model: "gpt-5.6-luna" } as const;
const BUNDLE_HASH = Array.from({ length: 64 }, () => "a").join("");
const CREDENTIAL = ["worker", "fixture", "admission"].join("-");
const WORKER_INFERENCE_START_TIMEOUT_MS = 90_000;

type InferencePlan =
  | "text"
  | "read-image"
  | "tool"
  | "safe-tool"
  | "background-tool"
  | "process-poll"
  | "process-kill"
  | "session-tool"
  | "computer"
  | "hold"
  | "fence"
  | "error"
  | "cancelled"
  | "length"
  | "burst-text"
  | "oversized-text"
  | "oversized-error"
  | "empty-terminal"
  | { args: Record<string, unknown>; toolCallId: string; toolName: string };
type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];

type FakeGatewayOptions = {
  admissionFailure?: "gateway-unavailable" | "invalid-credential" | "owner-epoch-mismatch";
  backgroundCommand?: string;
  backgroundYieldMs?: number;
  execCommand?: string;
  execApprovals?: Parameters<typeof saveExecApprovals>[0];
  inferencePlans?: InferencePlan[];
  outageOnInferenceCancel?: boolean;
  ignoreFirstAdmission?: boolean;
  ignoreHeartbeat?: boolean;
  silenceFirstTranscript?: boolean;
  silenceFirstLiveEvent?: boolean;
  silenceFirstInference?: boolean;
  dropSessionToolResponses?: number;
  transcriptFailureAtRequest?: number;
  liveResyncAckedSeq?: number;
  liveResyncResponses?: number;
  liveFailure?: "capacity-exceeded";
  heartbeatFailure?: "credential-expired";
  heartbeatIntervalMs?: number;
  computerSnapshot?: string;
  computerCleanupFailure?: boolean;
  onComputerClose?: () => void;
};

function assistantMessage(
  content: WorkerDoneMessage["content"],
  stopReason: WorkerDoneMessage["stopReason"],
): WorkerDoneMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: MODEL_REF.provider,
    model: MODEL_REF.model,
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

class FakeWorkerGateway {
  config?: OpenClawConfig;
  toolSurface!: () => WorkerToolSurface;
  private readonly httpServer: Server;
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private rootDir: string | undefined;
  private inferencePlanIndex = 0;
  private droppedTranscript = false;
  private droppedLiveEvent = false;
  private droppedInference = false;
  private sentLiveResync = 0;
  private unavailable = false;
  private ignoredAdmission = false;
  private readonly inferenceStarted = createDeferred();

  socketPath = "";
  connectionCount = 0;
  readonly methods: string[] = [];
  readonly transcriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly acceptedTranscriptRequests: WorkerTranscriptCommitParams[] = [];
  readonly liveEventRequests: WorkerLiveEventParams[] = [];
  readonly inferenceRequests: WorkerInferenceStartParams[] = [];
  readonly gatewayToolRequests: WorkerGatewayToolInvokeParams[] = [];
  readonly computerRequests: WorkerComputerParams[] = [];
  readonly applicationOrder: string[] = [];

  waitForInferenceStart(): Promise<void> {
    return withTestTimeout(
      this.inferenceStarted.promise,
      WORKER_INFERENCE_START_TIMEOUT_MS,
      "worker inference start did not reach the fake Gateway",
    );
  }

  constructor(private readonly options: FakeGatewayOptions = {}) {
    this.httpServer = createServer();
    this.webSocketServer = new WebSocketServer({ server: this.httpServer });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    // Leave room for the isolated test temp root within macOS Unix socket limits.
    this.rootDir = await mkdtemp(path.join(tmpdir(), "oc-wg-"));
    this.socketPath = path.join(this.rootDir, "gateway.sock");
    const listening = once(this.webSocketServer, "listening");
    this.httpServer.listen(this.socketPath);
    await listening;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
    if (this.rootDir) {
      await rm(this.rootDir, { recursive: true, force: true });
    }
  }

  disconnectClients(): void {
    for (const client of this.clients) {
      client.terminate();
    }
  }

  private accept(socket: WebSocket): void {
    this.connectionCount += 1;
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("message", (data: RawData) => this.handleMessage(socket, data));
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    if (Value.Check(WorkerConnectRequestFrameSchema, parsed)) {
      this.handleConnect(socket, parsed as WorkerConnectRequestFrame);
      return;
    }
    if (Value.Check(WorkerHeartbeatRequestFrameSchema, parsed)) {
      this.handleHeartbeat(socket, parsed as WorkerHeartbeatRequestFrame);
      return;
    }
    if (Value.Check(WorkerTranscriptCommitRequestFrameSchema, parsed)) {
      this.handleTranscript(socket, parsed as WorkerTranscriptCommitRequestFrame);
      return;
    }
    if (Value.Check(WorkerLiveEventRequestFrameSchema, parsed)) {
      this.handleLiveEvent(socket, parsed as WorkerLiveEventRequestFrame);
      return;
    }
    if (Value.Check(WorkerInferenceStartRequestFrameSchema, parsed)) {
      this.handleInference(socket, parsed as WorkerInferenceStartRequestFrame);
      return;
    }
    if (Value.Check(WorkerInferenceCancelRequestFrameSchema, parsed)) {
      this.handleInferenceCancel(socket, parsed as WorkerInferenceCancelRequestFrame);
      return;
    }
    if (isRecord(parsed) && parsed.type === "req" && typeof parsed.id === "string") {
      if (parsed.method === "worker.gatewayTool.cancel") {
        this.methods.push(parsed.method);
        this.send(socket, { type: "res", id: parsed.id, ok: true, payload: { cancelled: false } });
        return;
      }
      if (parsed.method === "worker.computer" && validateWorkerComputerParams(parsed.params)) {
        this.computerRequests.push(parsed.params);
        const closing = parsed.params.command === "computer.act";
        this.applicationOrder.push(closing ? "computer:close" : "computer:snapshot");
        if (closing) {
          this.options.onComputerClose?.();
        }
        this.send(
          socket,
          this.options.computerCleanupFailure && closing
            ? {
                type: "res",
                id: parsed.id,
                ok: false,
                error: {
                  code: "UNAVAILABLE",
                  message: "fixture desktop cleanup failed",
                  details: { reason: "gateway-unavailable" },
                },
              }
            : {
                type: "res",
                id: parsed.id,
                ok: true,
                payload: {
                  resultJson: JSON.stringify(
                    closing
                      ? { ok: true }
                      : {
                          format: "png",
                          base64: this.options.computerSnapshot,
                          width: 512,
                          height: 512,
                          displayFrameId: "worker-frame",
                          screenIndex: 0,
                        },
                  ),
                },
              },
        );
        return;
      }
      if (
        parsed.method === "worker.gatewayTool.invoke" &&
        validateWorkerGatewayToolInvokeParams(parsed.params)
      ) {
        this.handleGatewayTool(socket, parsed.id, parsed.params);
        return;
      }
    }
    const unsupported: unknown = parsed;
    if (isRecord(unsupported) && typeof unsupported.method === "string") {
      this.methods.push(unsupported.method);
    }
    socket.close(1008, "invalid-frame");
  }

  private handleConnect(socket: WebSocket, frame: WorkerConnectRequestFrame): void {
    this.methods.push(frame.method);
    if (this.unavailable) {
      socket.terminate();
      return;
    }
    if (this.options.ignoreFirstAdmission && !this.ignoredAdmission) {
      this.ignoredAdmission = true;
      return;
    }
    if (this.options.admissionFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker fixture rejected",
          details: { reason: this.options.admissionFailure },
          retryable: true,
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        type: "worker-hello-ok",
        toolSurface: this.toolSurface(),
        environmentId: frame.params.admission.environmentId,
        sessionId: frame.params.admission.sessionId,
        ownerEpoch: frame.params.admission.ownerEpoch,
        rpcSetVersion: frame.params.admission.rpcSetVersion,
        protocolFeatures: [...frame.params.admission.handshake.protocolFeatures],
        credentialExpiresAtMs: Date.now() + 60_000,
        policy: {
          heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 60_000,
          maxPayload: 25 * 1024 * 1024,
        },
      },
    });
  }

  private handleHeartbeat(socket: WebSocket, frame: WorkerHeartbeatRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.ignoreHeartbeat) {
      return;
    }
    if (this.options.heartbeatFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker heartbeat rejected",
          details: { reason: this.options.heartbeatFailure },
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { receivedAtMs: Date.now(), status: "ok", ownerEpoch: OWNER_EPOCH },
    });
  }

  private handleInferenceCancel(socket: WebSocket, frame: WorkerInferenceCancelRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.outageOnInferenceCancel) {
      this.unavailable = true;
      socket.terminate();
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "cancelled" },
    });
  }

  private handleGatewayTool(
    socket: WebSocket,
    id: string,
    request: WorkerGatewayToolInvokeParams,
  ): void {
    this.methods.push("worker.gatewayTool.invoke");
    this.gatewayToolRequests.push(structuredClone(request));
    if (this.gatewayToolRequests.length <= (this.options.dropSessionToolResponses ?? 0)) {
      // Lose the response after recording its request, without a heartbeat race.
      socket.terminate();
      return;
    }
    this.send(socket, {
      type: "res",
      id,
      ok: true,
      payload:
        request.toolId === "presence"
          ? {
              content: [{ type: "text", text: "Ada is online" }],
              details: { status: "ok", people: [{ name: "Ada" }] },
            }
          : {
              content: [{ type: "text", text: "child accepted" }],
              details: { status: "accepted", childSessionKey: "agent:main:cloud-child" },
            },
    });
  }

  private handleTranscript(socket: WebSocket, frame: WorkerTranscriptCommitRequestFrame): void {
    this.methods.push(frame.method);
    this.transcriptRequests.push(structuredClone(frame.params));
    if (this.options.silenceFirstTranscript && !this.droppedTranscript) {
      this.droppedTranscript = true;
      return;
    }
    if (this.transcriptRequests.length === this.options.transcriptFailureAtRequest) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker transcript commit rejected",
          details: { reason: "stale-base-leaf" },
        },
      });
      return;
    }
    this.acceptedTranscriptRequests.push(structuredClone(frame.params));
    this.applicationOrder.push(`transcript:${frame.params.seq}`);
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        entryIds: frame.params.messages.map(
          (_message, index) => `entry-${frame.params.seq}-${index}`,
        ),
        newLeafId: `leaf-${frame.params.seq}`,
      },
    });
  }

  private handleLiveEvent(socket: WebSocket, frame: WorkerLiveEventRequestFrame): void {
    this.methods.push(frame.method);
    this.liveEventRequests.push(structuredClone(frame.params));
    this.applicationOrder.push(
      frame.params.event.kind === "lifecycle"
        ? `live:lifecycle:${frame.params.event.payload.phase}`
        : `live:${frame.params.event.kind}`,
    );
    if (this.options.silenceFirstLiveEvent && !this.droppedLiveEvent) {
      this.droppedLiveEvent = true;
      return;
    }
    if (
      this.options.liveResyncAckedSeq !== undefined &&
      this.sentLiveResync < (this.options.liveResyncResponses ?? 1)
    ) {
      this.sentLiveResync += 1;
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker live event rejected",
          details: {
            reason: "resync-required",
            ackedSeq: this.options.liveResyncAckedSeq,
            expectedSeq: this.options.liveResyncAckedSeq + 1,
          },
        },
      });
      return;
    }
    if (this.options.liveFailure) {
      this.send(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "worker live event rejected",
          details: { reason: this.options.liveFailure },
        },
      });
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { ackedSeq: frame.params.seq },
    });
  }

  private handleInference(socket: WebSocket, frame: WorkerInferenceStartRequestFrame): void {
    this.methods.push(frame.method);
    this.inferenceRequests.push(structuredClone(frame.params));
    if (this.inferencePlanIndex === 0 && this.options.execApprovals) {
      saveExecApprovals(this.options.execApprovals);
    }
    this.inferenceStarted.resolve();
    if (this.options.silenceFirstInference && !this.droppedInference) {
      this.droppedInference = true;
      return;
    }
    this.send(socket, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "accepted" },
    });
    const plan = this.options.inferencePlans?.[this.inferencePlanIndex] ?? "text";
    this.inferencePlanIndex += 1;
    if (typeof plan === "object") {
      this.sendToolCallTurn(socket, frame.params, plan);
      return;
    }
    if (plan === "read-image") {
      this.sendToolCallTurn(socket, frame.params, {
        args: { path: "attachment.png" },
        toolCallId: "read-attachment",
        toolName: "read",
      });
      return;
    }
    if (plan === "hold") {
      return;
    }
    if (plan === "fence") {
      setTimeout(() => socket.close(1008, "owner-epoch-mismatch"), 5);
      return;
    }
    if (plan === "error" || plan === "cancelled") {
      this.sendTerminalOutcome(socket, frame.params, 1, {
        type: "error",
        reason: plan === "error" ? "provider-error" : "cancelled",
        message: plan === "error" ? "fixture provider failed" : "fixture inference cancelled",
      });
      return;
    }
    if (plan === "tool" || plan === "safe-tool" || plan === "background-tool") {
      this.sendToolTurn(socket, frame.params, {
        background: plan === "background-tool",
        safe: plan === "safe-tool",
      });
      return;
    }
    if (plan === "process-poll" || plan === "process-kill") {
      const processResult = this.acceptedTranscriptRequests
        .flatMap((request) => request.messages)
        .find((message) => message.role === "toolResult" && message.toolName === "exec");
      const details = processResult?.role === "toolResult" ? processResult.details : undefined;
      this.sendToolCallTurn(socket, frame.params, {
        args: {
          action: plan === "process-poll" ? "poll" : "kill",
          sessionId: isRecord(details) ? details.sessionId : undefined,
        },
        toolCallId: plan,
        toolName: "process",
      });
      return;
    }
    if (plan === "session-tool") {
      this.sendSessionToolTurn(socket, frame.params);
      return;
    }
    if (plan === "computer") {
      this.sendToolCallTurn(socket, frame.params, {
        toolCallId: "worker-screenshot",
        toolName: "computer",
        args: { action: "screenshot" },
      });
      return;
    }
    if (plan === "burst-text") {
      this.sendBurstTextTurn(socket, frame.params);
      return;
    }
    if (plan === "oversized-text") {
      this.sendBurstTextTurn(socket, frame.params, 1_700);
      return;
    }
    if (plan === "oversized-error") {
      this.sendBurstTextTurn(socket, frame.params, 1_700, "error");
      return;
    }
    if (plan === "empty-terminal") {
      this.sendEmptyTerminalTurn(socket, frame.params);
      return;
    }
    this.sendTextTurn(socket, frame.params, plan === "length" ? "length" : "stop");
  }

  private sendBurstTextTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    chunkCount = 1_100,
    terminal: "done" | "error" = "done",
  ): void {
    const chunk = "x".repeat(40);
    this.sendInferenceEvent(socket, identity, 1, {
      type: "start",
      resolvedModel: { api: "openai-responses", ...MODEL_REF },
      timestamp: Date.now(),
    });
    this.sendInferenceEvent(socket, identity, 2, { type: "text_start", contentIndex: 0 });
    for (let index = 0; index < chunkCount; index += 1) {
      this.sendInferenceEvent(socket, identity, index + 3, {
        type: "text_delta",
        contentIndex: 0,
        delta: chunk,
      });
    }
    const text = chunk.repeat(chunkCount);
    if (terminal === "error") {
      this.sendTerminalOutcome(socket, identity, chunkCount + 3, {
        type: "error",
        reason: "provider-error",
        message: "fixture provider failed after streaming",
      });
    } else {
      this.sendTerminal(
        socket,
        identity,
        chunkCount + 3,
        assistantMessage([{ type: "text", text }], "stop"),
      );
    }
  }

  private sendEmptyTerminalTurn(socket: WebSocket, identity: WorkerInferenceStartParams): void {
    this.sendInferenceEvent(socket, identity, 1, {
      type: "start",
      resolvedModel: { api: "openai-responses", ...MODEL_REF },
      timestamp: Date.now(),
    });
    this.sendInferenceEvent(socket, identity, 2, { type: "text_start", contentIndex: 0 });
    this.sendInferenceEvent(socket, identity, 3, {
      type: "text_delta",
      contentIndex: 0,
      delta: "discarded draft",
    });
    this.sendTerminal(socket, identity, 4, assistantMessage([], "stop"));
  }

  private sendTextTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    stopReason: "stop" | "length" = "stop",
  ): void {
    this.sendInferenceEvent(socket, identity, 1, {
      type: "start",
      resolvedModel: { api: "openai-responses", ...MODEL_REF },
      timestamp: Date.now(),
    });
    this.sendInferenceEvent(socket, identity, 2, { type: "text_start", contentIndex: 0 });
    this.sendInferenceEvent(socket, identity, 3, {
      type: "text_delta",
      contentIndex: 0,
      delta: "worker reply",
    });
    this.sendInferenceEvent(socket, identity, 4, { type: "text_end", contentIndex: 0 });
    this.sendTerminal(
      socket,
      identity,
      5,
      assistantMessage([{ type: "text", text: "worker reply" }], stopReason),
    );
  }

  private sendToolTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    options: { background: boolean; safe: boolean },
  ): void {
    const toolCallId = "local-exec-call";
    const args = options.background
      ? {
          // POSIX sleep avoids Node startup; Windows keeps the portable Node fixture.
          command:
            this.options.backgroundCommand ??
            (process.platform === "win32"
              ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                  "setInterval(() => undefined, 1000)",
                )}`
              : "exec sleep 60"),
          ...(this.options.backgroundYieldMs === undefined
            ? { background: true }
            : { yieldMs: this.options.backgroundYieldMs }),
        }
      : {
          command:
            this.options.execCommand ??
            (options.safe ? "wc -c" : "printf worker-local > local-proof.txt"),
        };
    this.sendToolCallTurn(socket, identity, {
      args,
      toolCallId,
      toolName: "exec",
    });
  }

  private sendSessionToolTurn(socket: WebSocket, identity: WorkerInferenceStartParams): void {
    this.sendToolCallTurn(socket, identity, {
      args: { task: "start a nested cloud child" },
      toolCallId: "nested-session-spawn-call",
      toolName: "sessions_spawn",
    });
  }

  private sendToolCallTurn(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    tool: { args: Record<string, unknown>; toolCallId: string; toolName: string },
  ): void {
    const { args, toolCallId, toolName } = tool;
    const encodedArgs = JSON.stringify(args);
    this.sendInferenceEvent(socket, identity, 1, {
      type: "start",
      resolvedModel: { api: "openai-responses", ...MODEL_REF },
      timestamp: Date.now(),
    });
    this.sendInferenceEvent(socket, identity, 2, {
      type: "toolcall_start",
      contentIndex: 0,
      id: toolCallId,
      toolName,
    });
    this.sendInferenceEvent(socket, identity, 3, {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: encodedArgs,
    });
    this.sendInferenceEvent(socket, identity, 4, { type: "toolcall_end", contentIndex: 0 });
    this.sendTerminal(
      socket,
      identity,
      5,
      assistantMessage(
        [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
        "toolUse",
      ),
    );
  }

  private sendInferenceEvent(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    seq: number,
    event: WorkerInferenceEventFrame["payload"]["event"],
  ): void {
    const frame: WorkerInferenceEventFrame = {
      type: "event",
      event: "worker.inference.event",
      payload: { ...this.identity(identity), seq, event },
    };
    this.send(socket, frame);
  }

  private sendTerminal(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    seq: number,
    message: WorkerDoneMessage,
  ): void {
    this.sendTerminalOutcome(socket, identity, seq, { type: "done", message });
  }

  private sendTerminalOutcome(
    socket: WebSocket,
    identity: WorkerInferenceStartParams,
    seq: number,
    outcome: WorkerInferenceTerminalOutcome,
  ): void {
    const frame: WorkerInferenceTerminalFrame = {
      type: "event",
      event: "worker.inference.terminal",
      payload: { ...this.identity(identity), seq, outcome },
    };
    this.send(socket, frame);
  }

  private identity(params: WorkerInferenceStartParams) {
    return {
      runEpoch: params.runEpoch,
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
    };
  }

  private send(socket: WebSocket, frame: object): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

function descriptor(socketPath: string, workspaceDir: string): WorkerLaunchDescriptor {
  return {
    version: 4,
    connectionEndpoint: { kind: "unix", socketPath },
    admission: {
      environmentId: "worker-environment",
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      ownerEpoch: OWNER_EPOCH,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "worker-test",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "worker-agent",
      runId: RUN_ID,
      operationalRunInstance: createOperationalRunInstanceRef(RUN_ID),
      agentRuntimeIdentityToken: "test-agent-runtime-token",
      turnId: "worker-turn",
      prompt: "Complete the worker turn.",
      suppressPromptTranscript: false,
      workspaceDir,
      modelRef: MODEL_REF,
      inferenceOptions: { reasoning: "off" },
      initialMessages: [],
      transcript: { baseLeafId: "leaf-base", nextSeq: 3 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: {
        allowedToolNames: ["read", "write", "edit", "apply_patch", "exec", "process"],
        exec: { host: "gateway", security: "full", ask: "off" },
      },
    },
  };
}

const gateways: FakeWorkerGateway[] = [];
const tempDirs: string[] = [];
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

async function setup(options?: FakeGatewayOptions): Promise<{
  gateway: FakeWorkerGateway;
  workspaceDir: string;
  launch: WorkerLaunchDescriptor;
}> {
  const gateway = new FakeWorkerGateway(options);
  gateways.push(gateway);
  await gateway.start();
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-workspace-"));
  tempDirs.push(workspaceDir);
  const launch = descriptor(gateway.socketPath, workspaceDir);
  gateway.toolSurface = () =>
    createWorkerToolSurfaceForTest({
      assignment: launch.assignment,
      config: gateway.config,
      sessionId: SESSION_ID,
    });
  return { gateway, workspaceDir, launch };
}

afterEach(async () => {
  browserRuntimeMocks.createWorkerBrowserToolRuntime.mockClear();
  browserRuntimeMocks.dispose.mockClear();
  for (const gateway of gateways.splice(0)) {
    await gateway.stop();
  }
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("worker runtime", () => {
  registerWorkerBackgroundExecLifecycleTests({
    setup,
    waitForFast,
    bundleHash: BUNDLE_HASH,
    sessionId: SESSION_ID,
    inferenceStartTimeoutMs: WORKER_INFERENCE_START_TIMEOUT_MS,
  });

  it("settles a real image above 64 KiB through input and a tool result", async () => {
    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: ["read-image", "text"],
    });
    const png = createNoisyPngBuffer(256, 256);
    expect(png.length).toBeGreaterThan(64 * 1024);
    const image = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
    await writeFile(path.join(workspaceDir, "attachment.png"), png);
    launch.assignment.prompt = [image];
    launch.assignment.initialMessages = [{ role: "user", content: [image], timestamp: 1 }];

    const result = await runWorkerDescriptor(parseWorkerLaunchDescriptor(launch));

    expect(result.status).toBe("completed");
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.inferenceRequests[0]?.context.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([[image], [image]]);
    const messages = gateway.acceptedTranscriptRequests.flatMap((request) => request.messages);
    const toolResult = messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
    expect(toolResult?.content).toContainEqual(image);
    expect(gateway.inferenceRequests[1]?.context.messages).toContainEqual(toolResult);
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(
      gateway.applicationOrder.findIndex((entry) => entry === "live:lifecycle:finishing"),
    ).toBeGreaterThan(
      gateway.applicationOrder.findLastIndex((entry) => entry.startsWith("transcript:")),
    );
  });

  registerWorkerPromptTests({ setup, modelRef: MODEL_REF });

  registerWorkerGatewayToolAvailabilityTests({ setup });

  it("settles Browser, computer, and transcript owners concurrently before finishing", async () => {
    const browserRelease = createDeferred();
    let browserPending = false;
    let overlappingComputerClose = false;
    let overlappingTranscriptSettlement = false;
    const { gateway, launch } = await setup({
      inferencePlans: ["computer", "text"],
      computerSnapshot: createSolidPngBuffer(512, 512, { r: 0, g: 128, b: 255 }).toString("base64"),
      onComputerClose: () => {
        overlappingComputerClose = browserPending;
        browserRelease.resolve();
      },
    });
    browserRuntimeMocks.dispose.mockImplementationOnce(async () => {
      browserPending = true;
      await browserRelease.promise;
      browserPending = false;
      gateway.applicationOrder.push("browser:disposed");
    });
    const createTranscript = workerTranscriptRuntime.createWorkerTranscriptRuntime;
    const transcriptSpy = vi
      .spyOn(workerTranscriptRuntime, "createWorkerTranscriptRuntime")
      .mockImplementation((client, signal) => {
        const runtime = createTranscript(client, signal);
        const settle = runtime.withSessionWriteSettlement;
        runtime.withSessionWriteSettlement = (operation) => {
          overlappingTranscriptSettlement ||= browserPending;
          return settle(operation);
        };
        return runtime;
      });
    launch.assignment.toolAuthority.allowedToolNames = ["browser", "computer"];
    launch.assignment.browser = {
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
    };
    launch.assignment.computer = {
      nodeId: "worker-desktop",
      computerUse: {
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
        actions: ["screenshot"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      },
    };
    try {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    } finally {
      browserRelease.resolve();
      transcriptSpy.mockRestore();
    }

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "browser",
      "computer",
    ]);
    expect(browserRuntimeMocks.createWorkerBrowserToolRuntime).toHaveBeenCalledWith({
      descriptor: launch.assignment.browser,
      sessionKey: `agent:worker-agent:worker:${SESSION_ID}`,
      stateDir: expect.any(String),
      workspaceDir: await realpath(launch.assignment.workspaceDir),
    });
    expect(browserRuntimeMocks.dispose).toHaveBeenCalledOnce();
    expect(overlappingComputerClose).toBe(true);
    expect(overlappingTranscriptSettlement).toBe(true);
    expect(gateway.applicationOrder.indexOf("browser:disposed")).toBeLessThan(
      gateway.applicationOrder.indexOf("live:lifecycle:finishing"),
    );
    expect(gateway.applicationOrder.indexOf("computer:close")).toBeLessThan(
      gateway.applicationOrder.indexOf("live:lifecycle:finishing"),
    );
    expect(
      gateway.applicationOrder.findLastIndex((entry) => entry.startsWith("transcript:")),
    ).toBeLessThan(gateway.applicationOrder.indexOf("live:lifecycle:finishing"));
  });

  it.each(["error", "setup"] as const)(
    "retains browser disposal failure together with the %s outcome",
    async (outcome) => {
      const { gateway, launch } = await setup({
        inferencePlans: [outcome === "error" ? "error" : "text"],
      });
      launch.assignment.toolAuthority.allowedToolNames = ["browser"];
      launch.assignment.browser = {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      };
      const createSession =
        outcome === "setup"
          ? vi
              .spyOn(agentSessionSdk, "createAgentSession")
              .mockRejectedValueOnce(new Error("fixture setup failed"))
          : undefined;
      browserRuntimeMocks.dispose.mockRejectedValueOnce(
        new Error("fixture browser cleanup failed"),
      );
      try {
        if (outcome === "setup") {
          const error = await runWorkerDescriptor(launch).catch((cause: unknown) => cause);
          expect(formatErrorMessage(error)).toContain("fixture setup failed");
          expect(formatErrorMessage(error)).toContain("fixture browser cleanup failed");
          expect(hasModelFallbackStop(error)).toBe(true);
          expect(gateway.liveEventRequests).toHaveLength(0);
        } else {
          await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "failed" });
          expect(gateway.liveEventRequests.at(-1)?.event.payload).toMatchObject({
            phase: "finishing",
            stopReason: "error",
            error: expect.stringContaining("fixture browser cleanup failed"),
            replayInvalid: true,
          });
          if (outcome === "error") {
            expect(gateway.liveEventRequests.at(-1)?.event.payload).toMatchObject({
              error: expect.stringContaining("fixture provider failed"),
            });
          }
        }
        expect(browserRuntimeMocks.dispose).toHaveBeenCalledOnce();
      } finally {
        createSession?.mockRestore();
      }
    },
  );

  it.each([
    { computerCleanupFailure: true, terminal: "error" },
    { computerCleanupFailure: true, terminal: "cancelled" },
  ] as const)(
    "keeps desktop images through RPC, transcript, and inference before closing (cleanup failure: $computerCleanupFailure, terminal: $terminal)",
    async ({ computerCleanupFailure, terminal }) => {
      const computerSnapshot = createNoisyPngBuffer(512, 512).toString("base64");
      expect(computerSnapshot.length).toBeGreaterThan(64 * 1024);
      const { gateway, launch } = await setup({
        inferencePlans: ["computer", terminal],
        computerSnapshot,
        computerCleanupFailure,
      });
      launch.assignment.toolAuthority.allowedToolNames = ["computer"];
      launch.assignment.computer = {
        nodeId: "worker-desktop",
        computerUse: {
          contractVersion: 2,
          provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
          actions: ["screenshot"],
          targets: ["screen"],
          deliveryModes: ["foreground"],
          observations: ["image"],
          features: { recording: false, agentCursor: false, multiDisplay: false },
        },
      };

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
        status: "failed",
      });

      expect(gateway.computerRequests.map((request) => request.command)).toEqual([
        "screen.snapshot",
        "computer.act",
      ]);
      expect(JSON.parse(gateway.computerRequests[1]!.paramsJson)).toMatchObject({
        action: "__close_execution",
      });
      const screenshot = gateway.acceptedTranscriptRequests
        .flatMap((request) => request.messages.filter((message) => message.role === "toolResult"))
        .find((message) => message.toolName === "computer");
      expect(screenshot).toMatchObject({
        isError: false,
        content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
      });
      const image = screenshot?.content.find((part) => part.type === "image");
      expect(image?.type === "image" && image.data.length).toBeGreaterThan(64 * 1024);
      expect(gateway.inferenceRequests[1]?.context.messages).toContainEqual(screenshot);
      const computer = gateway.inferenceRequests[0]?.context.tools?.find(
        (tool) => tool.name === "computer",
      );
      expect(computer?.parameters).not.toHaveProperty("properties.node");
      expect(computer?.parameters).not.toHaveProperty("properties.gatewayToken");
      expect(gateway.applicationOrder.indexOf("computer:close")).toBeLessThan(
        gateway.applicationOrder.indexOf("live:lifecycle:finishing"),
      );
      if (computerCleanupFailure) {
        expect(gateway.liveEventRequests.at(-1)?.event.payload).toHaveProperty(
          "replayInvalid",
          true,
        );
      } else {
        expect(gateway.liveEventRequests.at(-1)?.event.payload).not.toHaveProperty("replayInvalid");
      }
      if (terminal === "cancelled") {
        expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
          kind: "lifecycle",
          payload: { phase: "finishing", stopReason: "aborted" },
        });
        expect(gateway.liveEventRequests.at(-1)?.event.payload).not.toHaveProperty("error");
      } else if (computerCleanupFailure) {
        expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
          kind: "lifecycle",
          payload: {
            phase: "finishing",
            stopReason: "error",
            error: expect.stringContaining(
              "computer: session desktop cleanup failed | fixture desktop cleanup failed",
            ),
          },
        });
        if (terminal === "error") {
          expect(gateway.liveEventRequests.at(-1)?.event.payload).toMatchObject({
            error: expect.stringContaining("fixture provider failed"),
          });
        }
      }
    },
  );

  it.each([
    { authority: ["browser"] as const, browser: undefined },
    {
      authority: ["read"] as const,
      browser: {
        cdpUrl: "http://127.0.0.1:9222",
        launcherPath: "/usr/local/bin/openclaw-worker-browser",
      },
    },
  ])("fails before inference when Browser authority and descriptor disagree", async (testCase) => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [...testCase.authority];
    if (testCase.browser) {
      launch.assignment.browser = testCase.browser;
    } else {
      delete launch.assignment.browser;
    }

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "Worker Browser authority and launch descriptor must be provided together",
    );
    expect(gateway.inferenceRequests).toHaveLength(0);
  });

  registerWorkerGatewayToolRpcTests({ setup });

  it.each([
    { name: "spawn", toolId: "sessions_spawn", arguments: { task: "start a nested cloud child" } },
  ])("replays the same durable $name operation across response loss", async (testCase) => {
    const { gateway, launch } = await setup({ dropSessionToolResponses: 2 });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    const states: WorkerConnectionState["kind"][] = [];
    connection.onStateChange((state) => states.push(state.kind));
    try {
      await connection.start();
      const request = {
        generation: "runtime-surface",
        toolCallId: `call-durable-${testCase.name}`,
        toolId: testCase.toolId,
        arguments: testCase.arguments,
      };
      const response = await connection.invokeGatewayTool(request, { replay: true });

      expect(response).toMatchObject({
        ok: true,
        payload: { content: [{ type: "text", text: "child accepted" }] },
      });
      expect(gateway.connectionCount).toBe(3);
      expect(states.filter((state) => state === "ready")).toHaveLength(3);
      expect(gateway.gatewayToolRequests).toEqual([request, request, request]);
    } finally {
      await connection.stop();
    }
  });

  it("never replays a portal operation after its response is lost", async () => {
    const { gateway, launch } = await setup({ dropSessionToolResponses: 1 });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await connection.start();
      const request = {
        generation: "runtime-surface",
        toolId: "portal",
        toolCallId: "call-portal-once",
        arguments: { action: "open", port: 3000 },
      };

      await expect(connection.invokeGatewayTool(request)).rejects.toMatchObject({
        name: "WorkerConnectionInterruptedError",
      });
      expect(gateway.gatewayToolRequests).toEqual([request]);
    } finally {
      await connection.stop();
    }
  });

  it("fail-stops a stale mid-run transcript without duplicating or rebasing the paid tail", async () => {
    const { gateway, launch } = await setup({ transcriptFailureAtRequest: 2 });

    const failure: unknown = await runWorkerDescriptor(launch).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: "WorkerTranscriptCommitError",
      message:
        "Worker transcript base changed; uncommitted messages were not committed; relaunch required.",
      reason: "stale-base-leaf",
    });
    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.transcriptRequests.map((request) => request.seq)).toEqual([3, 4]);
    expect(
      gateway.transcriptRequests.map((request) => request.messages.map((message) => message.role)),
    ).toEqual([["user"], ["assistant"]]);
    expect(gateway.acceptedTranscriptRequests.map((request) => request.seq)).toEqual([3]);
    expect(
      gateway.liveEventRequests.some(
        (request) => request.event.kind === "lifecycle" && request.event.payload.phase === "error",
      ),
    ).toBe(false);
  });

  it("requires authoritative terminal delivery after degrading preview live events", async () => {
    const { gateway, launch } = await setup({ liveFailure: "capacity-exceeded" });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker live event rejected");

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(
      gateway.acceptedTranscriptRequests
        .flatMap((request) => request.messages)
        .map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(gateway.liveEventRequests.length).toBeGreaterThanOrEqual(2);
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing" },
    });
  });

  it("degrades a repeated no-progress live resync without hanging the run", async () => {
    const { gateway, launch } = await setup({
      liveResyncAckedSeq: 0,
      liveResyncResponses: 2,
    });
    launch.assignment.liveEvents = { ackedSeq: 5, nextSeq: 6 };

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests).toHaveLength(1);
    expect(gateway.acceptedTranscriptRequests).toHaveLength(2);
    expect(gateway.liveEventRequests).toHaveLength(3);
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing" },
    });
  });

  it("fails closed when worker admission is rejected", async () => {
    const { gateway, launch } = await setup({ admissionFailure: "invalid-credential" });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker admission rejected");
    expect(gateway.connectionCount).toBe(1);
  });

  it.each(["initial admission", "running turn"] as const)(
    "marks only an initial admission deadline as safe to re-arm: %s",
    async (phase) => {
      const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-admission-"));
      tempDirs.push(workspaceDir);
      const launch = descriptor(path.join(workspaceDir, "gateway.sock"), workspaceDir);
      const connection = createWorkerConnection({
        endpoint: launch.connectionEndpoint,
        connectParams: buildWorkerConnectParams(launch),
      });
      // Production formats the last failure into the deadline message
      // (WorkerConnection.failAdmissionDeadline); model that here.
      const deadline = new WorkerAdmissionDeadlineExceededError(
        "no admission after 3 attempts to gateway.sock: connect ECONNREFUSED",
      );
      const start = vi.spyOn(connection, "start");
      if (phase === "initial admission") {
        start.mockRejectedValue(deadline);
      } else {
        start.mockResolvedValue({
          type: "worker-hello-ok",
          toolSurface: {
            generation: "surface",
            presentation: createToolSurfacePresentationForTest(),
            tools: [],
            policy: prepareCoreToolPolicy({}),
          },
          environmentId: launch.admission.environmentId,
          sessionId: SESSION_ID,
          ownerEpoch: OWNER_EPOCH,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
          credentialExpiresAtMs: Date.now() + 60_000,
          policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
        });
      }
      const connectionModule = await import("./worker-connection.js");
      const factory = vi
        .spyOn(connectionModule, "createWorkerConnection")
        .mockImplementation((options) => {
          options.onConnectionFailure?.(new Error("connect ECONNREFUSED"));
          return connection;
        });
      const embeddedRuntime = await import("./embedded-agent.runtime.js");
      const runTurn = vi
        .spyOn(embeddedRuntime, "runWorkerEmbeddedTurn")
        .mockRejectedValue(deadline);
      try {
        if (phase === "initial admission") {
          await expect(runWorkerDescriptor(launch)).resolves.toEqual({
            status: "not-started",
            reason: "admission-deadline",
            errorText: expect.stringContaining("connect ECONNREFUSED"),
          });
          expect(runTurn).not.toHaveBeenCalled();
        } else {
          await expect(runWorkerDescriptor(launch)).rejects.toBe(deadline);
          expect(runTurn).toHaveBeenCalledOnce();
        }
      } finally {
        runTurn.mockRestore();
        factory.mockRestore();
        start.mockRestore();
        await connection.stop();
      }
    },
  );

  it("exits cleanly when admission observes a superseded owner epoch", async () => {
    const { launch } = await setup({ admissionFailure: "owner-epoch-mismatch" });

    await expect(runWorkerDescriptor(launch)).resolves.toEqual({
      status: "fenced",
      reason: "owner-epoch-mismatch",
    });
  });

  it("sends remote inference cancellation before stopping an active worker", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["hold"] });
    const controller = new AbortController();
    const result = runWorkerDescriptor(launch, { signal: controller.signal });
    await gateway.waitForInferenceStart();

    controller.abort(new Error("operator stopped worker"));

    await expect(result).rejects.toThrow("operator stopped worker");
    expect(gateway.methods).toContain("worker.inference.cancel");
    expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
      kind: "lifecycle",
      payload: { phase: "finishing", aborted: true },
    });
  });

  registerWorkerNativeInferenceTests({ setup });

  it("bounds shutdown when remote inference cancellation cannot settle", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["hold"],
      outageOnInferenceCancel: true,
    });
    const controller = new AbortController();
    const result = runWorkerDescriptor(launch, { signal: controller.signal });
    await gateway.waitForInferenceStart();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const rejected = expect(result).rejects.toThrow("operator stopped worker during outage");

      controller.abort(new Error("operator stopped worker during outage"));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(gateway.methods).toContain("worker.inference.cancel");
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fails closed when a heartbeat is rejected without fencing", async () => {
    const { launch } = await setup({
      inferencePlans: ["hold"],
      heartbeatFailure: "credential-expired",
      heartbeatIntervalMs: 1,
    });

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "worker heartbeat rejected: credential-expired",
    );
  });

  it.each(["oversized-text", "oversized-error"] as const)(
    "turns %s output into a persistable failed turn",
    async (plan) => {
      const { gateway, launch } = await setup({ inferencePlans: [plan] });

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
        status: "failed",
        reason: "turn-failed",
        transcriptLeafId: expect.any(String),
        transcriptNextSeq: expect.any(Number),
      });
      const assistant = gateway.transcriptRequests
        .flatMap((request) => request.messages)
        .toReversed()
        .find((message) => message.role === "assistant");
      expect(assistant).toMatchObject({ role: "assistant", stopReason: "error", content: [] });
      for (const request of gateway.transcriptRequests) {
        expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThan(64 * 1024);
      }
    },
  );

  it.each(["running", "completed", "cancelled", "ordinary-yield"] as const)(
    "keeps completed-turn commands controllable in the managed environment (%s)",
    async (scenario) => {
      const processState = scenario === "ordinary-yield" ? "running" : scenario;
      const { gateway, launch, workspaceDir } = await setup({
        inferencePlans: [
          "background-tool",
          "text",
          ...(processState === "cancelled" ? ["hold" as const] : []),
          "process-poll",
          ...(processState === "completed" ? [] : ["process-kill" as const]),
          "text",
        ],
        ...(processState === "completed"
          ? { backgroundCommand: `${JSON.stringify(process.execPath)} finish-on-release.cjs` }
          : {}),
        ...(scenario === "ordinary-yield" ? { backgroundYieldMs: 10 } : {}),
      });
      const releaseBackground = createDeferred();
      let completionServer: Server | undefined;
      if (processState === "completed") {
        completionServer = createServer((_request, response) => {
          void releaseBackground.promise.then(() => response.end("background-finished"));
        });
        const listening = once(completionServer, "listening");
        completionServer.listen(0, "127.0.0.1");
        await listening;
        const address = completionServer.address();
        if (!address || typeof address === "string") {
          throw new Error("background completion server did not allocate a TCP port");
        }
        // An explicit response also releases a child that starts after the turn finishes.
        // Filesystem watch notifications can be lost while this shared machine is busy.
        await writeFile(
          path.join(workspaceDir, "finish-on-release.cjs"),
          `require('node:http').get('http://127.0.0.1:${address.port}', response => response.pipe(process.stdout));`,
        );
      }
      const scopeKey = `worker:${SESSION_ID}`;
      const supervisor = getProcessSupervisor();
      const input = new PassThrough();
      const output = new PassThrough();
      const results: WorkerProcessResult[] = [];
      output.on("data", (chunk: Buffer) => {
        const result = parseWorkerProcessMessage(JSON.parse(chunk.toString("utf8")));
        if (result?.type === "result") {
          results.push(result);
        }
      });
      const command = runWorkerCommand({ managed: true, input, output });
      const settled = vi.fn();
      void command.then(settled, settled);

      try {
        input.write(
          JSON.stringify({ type: "turn", turnId: launch.assignment.turnId, descriptor: launch }) +
            "\n",
        );
        await waitForFast(() => expect(results).toHaveLength(1), { timeout: 30_000 });
        expect(results[0]).toMatchObject({
          turnId: launch.assignment.turnId,
          result: { status: "completed" },
          retainWorker: true,
        });
        const running = listRunningSessions().filter((session) => session.scopeKey === scopeKey);
        expect(running).toHaveLength(1);
        const sessionId = running[0]!.id;
        expect(settled).not.toHaveBeenCalled();
        if (processState === "completed") {
          releaseBackground.resolve();
          await waitForExecScope(scopeKey);
          await waitForFast(() =>
            expect(
              listRunningSessions().filter((session) => session.scopeKey === scopeKey),
            ).toHaveLength(0),
          );
          expect(settled).not.toHaveBeenCalled();
        }

        const sendNextTurn = (index: number) => {
          const next = structuredClone(launch);
          next.assignment.runId = `worker-next-run-${index}`;
          next.assignment.turnId = `worker-next-turn-${index}`;
          next.assignment.operationalRunInstance = createOperationalRunInstanceRef(
            next.assignment.runId,
          );
          next.assignment.agentRuntimeIdentityToken = `next-test-runtime-token-${index}`;
          next.admission.credential = `next-test-worker-credential-${index}`;
          next.assignment.initialMessages = gateway.acceptedTranscriptRequests.flatMap(
            (request) => request.messages,
          );
          input.write(
            `${JSON.stringify({ type: "turn", turnId: next.assignment.turnId, descriptor: next })}\n`,
          );
          return next.assignment.turnId;
        };
        const nextTurnId = sendNextTurn(2);
        if (processState === "cancelled") {
          await waitForFast(() => expect(gateway.inferenceRequests).toHaveLength(3), {
            timeout: 30_000,
          });
          input.write(`${JSON.stringify({ type: "cancel", turnId: nextTurnId })}\n`);
          await waitForFast(() => expect(results).toHaveLength(2), { timeout: 30_000 });
          expect(results[1]).toMatchObject({
            result: { status: "failed", reason: "turn-failed" },
            retainWorker: true,
          });
          sendNextTurn(3);
        }
        const turnCount = processState === "cancelled" ? 3 : 2;
        await waitForFast(() => expect(results).toHaveLength(turnCount), { timeout: 30_000 });
        expect(gateway.connectionCount).toBe(turnCount);
        const processResults = gateway.acceptedTranscriptRequests
          .flatMap((request) => request.messages)
          .filter((message) => message.role === "toolResult" && message.toolName === "process");
        if (processState !== "completed") {
          expect(processResults).toMatchObject([
            { details: { status: "running", sessionId } },
            { details: { status: "completed" } },
          ]);
        } else {
          expect(processResults).toMatchObject([
            {
              content: [{ type: "text", text: expect.stringContaining("background-finished") }],
              details: { status: "completed", exitCode: 0 },
            },
          ]);
          expect(results[1]?.retainWorker).toBe(false);
        }
      } finally {
        releaseBackground.resolve();
        input.end();
        try {
          await command;
        } finally {
          supervisor.cancelScope(scopeKey, "manual-cancel");
          await waitForExecScope(scopeKey);
          if (completionServer) {
            await new Promise<void>((resolve, reject) => {
              completionServer.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
      }
      expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toHaveLength(
        0,
      );
    },
  );

  registerWorkerExecEnvironmentFinalizationTests({
    runExecProcess,
    createWorkerRuntimeEnvironment,
  });

  it("revokes local tool handles when their worker turn closes", async () => {
    const { launch } = await setup();
    const adapter = await import("../agents/agent-tool-definition-adapter.js");
    const finalize = vi.spyOn(adapter, "toToolDefinitions");
    try {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
      const tools = finalize.mock.calls.at(-1)![0];
      const processTool = tools.find((tool) => tool.name === "process")!;
      await expect(
        processTool.execute("retained-process", { action: "list" }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
      const execTool = tools.find((tool) => tool.name === "exec")!;
      await expect(
        execTool.execute("retained-exec", { command: "echo stale-worker" }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      finalize.mockRestore();
    }
  });

  it("stops worker-scoped background processes when fenced", async () => {
    const { gateway, launch } = await setup({
      inferencePlans: ["background-tool", "fence"],
    });

    await expect(runWorkerDescriptor(launch)).resolves.toEqual({
      status: "fenced",
      reason: "owner-epoch-mismatch",
    });
    expect(gateway.inferenceRequests).toHaveLength(2);
    await waitForFast(
      () => {
        expect(
          listRunningSessions().filter((session) => session.scopeKey === `worker:${SESSION_ID}`),
        ).toHaveLength(0);
      },
      { timeout: 7_000 },
    );
  });

  it("executes coding tools locally without reading the preexisting auth profile", async () => {
    const { gateway, workspaceDir, launch } = await setup({ inferencePlans: ["tool", "text"] });
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const trapStateDir = path.join(workspaceDir, "state-trap");
    const authDir = path.join(trapStateDir, "agents", "main", "agent");
    const configTrap = path.join(workspaceDir, "config-trap");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth-profiles.json"), "not valid json", "utf8");
    await mkdir(configTrap);
    process.env.OPENCLAW_STATE_DIR = trapStateDir;
    process.env.OPENCLAW_CONFIG_PATH = configTrap;
    try {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
    }

    await expect(readFile(path.join(workspaceDir, "local-proof.txt"), "utf8")).resolves.toBe(
      "worker-local",
    );
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.inferenceRequests[1]?.context.messages.some(
        (message) => message.role === "toolResult",
      ),
    ).toBe(true);
    expect(
      gateway.methods.every((method) => method.startsWith("worker.") || method === "connect"),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "prevents retained processes from reading a later turn's GitHub profile",
    async ({ signal }) => {
      const { gateway, launch, workspaceDir } = await setup({
        inferencePlans: ["background-tool", "text", "tool", "text"],
        backgroundCommand: `exec '${process.execPath.replaceAll("'", "'\\''")}' retained-profile.mjs`,
        execCommand: "printf turn-b-completed",
      });
      const profilePath = path.join(workspaceDir, "retained-profile.txt");
      await writeFile(
        path.join(workspaceDir, "retained-profile.mjs"),
        [
          'import { execFile } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          fixtureReceiptClientSource(receipts.endpoint),
          `writeFileSync(${JSON.stringify(profilePath)}, process.env.GH_CONFIG_DIR);`,
          `sendReceipt(${JSON.stringify(profilePath)}, "ready");`,
          "await new Promise((resolve, reject) => {",
          `  execFile("sh", ["-c", ${JSON.stringify(
            [
              "while [ ! -e retained-marker ]; do sleep 0.01; done",
              '{ cat "$GH_CONFIG_DIR/hosts.yml"; printf "exit=%s\\n" "$?"; } > retained-read.tmp 2>&1',
              "mv retained-read.tmp retained-read.txt",
            ].join("; "),
          )}], (error) => error ? reject(error) : resolve());`,
          "});",
        ].join("\n"),
      );
      launch.assignment.github = {
        login: "worker-a",
        token: "worker-turn-a-token",
        branch: "openclaw/session-fixture",
      };
      const input = new PassThrough();
      const output = new PassThrough();
      const results: WorkerProcessResult[] = [];
      const idleReady = createDeferred<string>();
      output.on("data", (chunk: Buffer) => {
        const message = parseWorkerProcessMessage(JSON.parse(chunk.toString("utf8")));
        if (message?.type === "result") {
          results.push(message);
        } else if (message?.type === "idle-ready") {
          idleReady.resolve(message.turnId);
        }
      });
      const command = runWorkerCommand({ managed: true, input, output });
      const settled = vi.fn();
      void command.then(settled, settled);
      const scopeKey = `worker:${SESSION_ID}`;
      const supervisor = getProcessSupervisor();
      try {
        input.write(`${JSON.stringify(buildWorkerProcessTurn(launch, true))}\n`);
        await waitForFast(() => expect(results).toHaveLength(1), { timeout: 30_000 });
        expect(results[0]).toMatchObject({
          turnId: launch.assignment.turnId,
          result: { status: "completed" },
          retainWorker: true,
        });
        // A receipt can arrive after the exec settles; its durable file is written first.
        await withinTest(
          Promise.race([receipts.waitFor(profilePath, "ready"), waitForExecScope(scopeKey)]),
          signal,
        );
        const previousProfileDir = await readFile(profilePath, "utf8");
        expect(previousProfileDir).not.toBe("");
        const stateDir = process.env.OPENCLAW_STATE_DIR!;
        const next = structuredClone(launch);
        next.assignment.runId = "worker-next-run-2";
        next.assignment.turnId = "worker-next-turn-2";
        next.assignment.operationalRunInstance = createOperationalRunInstanceRef(
          next.assignment.runId,
        );
        next.assignment.agentRuntimeIdentityToken = "next-test-runtime-token-2";
        next.admission.credential = "next-test-worker-credential-2";
        next.assignment.initialMessages = gateway.acceptedTranscriptRequests.flatMap(
          (request) => request.messages,
        );
        next.assignment.github = {
          login: "worker-b",
          token: "worker-turn-b-token",
          branch: "openclaw/session-fixture",
        };
        input.write(`${JSON.stringify(buildWorkerProcessTurn(next, true))}\n`);
        await waitForFast(() => expect(results).toHaveLength(2), { timeout: 30_000 });
        expect(results[1]).toMatchObject({
          turnId: next.assignment.turnId,
          result: { status: "completed" },
          retainWorker: true,
        });
        const execResult = gateway.acceptedTranscriptRequests
          .flatMap((request) => request.messages)
          .findLast((message) => message.role === "toolResult" && message.toolName === "exec");
        expect(execResult).toMatchObject({
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("turn-b-completed") }],
        });
        expect(settled).not.toHaveBeenCalled();

        const nextProfileDir = path.join(
          stateDir,
          "github-profiles",
          createHash("sha256").update(next.assignment.turnId).digest("hex").slice(0, 16),
        );
        const hosts = await readFile(path.join(nextProfileDir, "hosts.yml"), "utf8");
        expect(hosts).toContain("worker-b");
        expect(hosts).not.toContain("worker-a");
        expect(hosts).not.toContain(launch.assignment.github.token);
        await writeFile(path.join(workspaceDir, "retained-marker"), "read");
        // idle-ready follows exec settlement and both profile disposals, including the shell's mv.
        expect(
          await withinTest(
            awaitGateBeforeSettlement(
              idleReady.promise,
              command,
              "worker command ended before the retained process became idle",
            ),
            signal,
          ),
        ).toBe(next.assignment.turnId);
        const retainedRead = await readFile(path.join(workspaceDir, "retained-read.txt"), "utf8");
        expect(retainedRead).toContain(launch.assignment.github.token);
        expect(retainedRead).not.toContain(next.assignment.github.token);
        expect(retainedRead).toMatch(/exit=0/u);
        await expect(stat(previousProfileDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(nextProfileDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        input.end();
        try {
          await command;
        } finally {
          supervisor.cancelScope(scopeKey, "manual-cancel");
          await waitForExecScope(scopeKey);
        }
      }
    },
  );

  registerWorkerGitHubTests({ setup, sessionId: SESSION_ID });

  registerWorkerPermissionTests({ setup });

  it("rejects a dot-dot workspace escape before worker connection", async () => {
    const { workspaceDir, launch } = await setup();
    const outside = await mkdtemp(path.join(tmpdir(), "openclaw-worker-outside-"));
    tempDirs.push(outside);
    launch.assignment.workspaceDir = path.join(workspaceDir, "..", path.basename(outside));
    launch.assignment.permissionMode = "workspace";
    launch.assignment.workerContainmentRoot = workspaceDir;

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "worker workspace path escapes its assigned containment root",
    );
  });

  registerWorkerReplayWindowTests({ setup, assistantMessage, modelRef: MODEL_REF });
});

describe("worker reconnect clients", () => {
  it("isolates ready listener failures while admitting the worker and starting heartbeats", async () => {
    const { gateway, launch } = await setup({ heartbeatIntervalMs: 1 });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
    });
    let healthyReadyCalls = 0;
    connection.onReady(() => {
      throw new Error("induced ready observer failure");
    });
    connection.onReady(() => {
      healthyReadyCalls += 1;
    });

    try {
      await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
      expect(healthyReadyCalls).toBe(1);
      await waitForFast(() => expect(gateway.methods).toContain("worker.heartbeat"));
    } finally {
      await connection.stop();
    }
  });

  it("fails closed when the overall admission deadline expires", async () => {
    const { gateway, launch } = await setup({ admissionFailure: "gateway-unavailable" });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      admissionTimeoutMs: 25,
      admissionDeadlineMs: 250,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await expect(connection.start()).rejects.toBeInstanceOf(WorkerAdmissionDeadlineExceededError);
      expect(gateway.connectionCount).toBeGreaterThan(1);
      expect(connection.state).toMatchObject({
        kind: "failed",
        error: expect.any(WorkerAdmissionDeadlineExceededError),
      });
      await expect(connection.waitForExit()).resolves.toMatchObject({
        kind: "failed",
        error: expect.any(WorkerAdmissionDeadlineExceededError),
      });
    } finally {
      await connection.stop();
    }
  });

  it("times out a silent admission attempt and admits on reconnect", async () => {
    const { gateway, launch } = await setup({ ignoreFirstAdmission: true });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      admissionTimeoutMs: 25,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      await connection.stop();
    }
  });

  it("times out a silent heartbeat and reconnects", async () => {
    const { gateway, launch } = await setup({
      ignoreHeartbeat: true,
      heartbeatIntervalMs: 1,
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 25,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    try {
      await connection.start();
      await waitForFast(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2));
    } finally {
      await connection.stop();
    }
  });

  it("replays exact RPC payloads after silent response timeouts", async () => {
    const { gateway, launch } = await setup({
      silenceFirstTranscript: true,
      silenceFirstLiveEvent: true,
      silenceFirstInference: true,
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: gateway.socketPath },
      connectParams: buildWorkerConnectParams(launch),
      requestTimeoutMs: 40,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    const transcript = new WorkerTranscriptCommitClient(connection, {
      runEpoch: OWNER_EPOCH,
      baseLeafId: "leaf-base",
      initialSeq: 8,
    });
    const live = new WorkerLiveEventClient(connection, { runEpoch: OWNER_EPOCH });
    const inference = new WorkerInferenceProxyClient(connection);
    try {
      await connection.start();
      await transcript.commit([
        {
          role: "user",
          content: [{ type: "text", text: "silent transcript" }],
          timestamp: 1,
        },
      ]);
      live.enqueuePreview(RUN_ID, {
        kind: "assistant",
        payload: { text: "silent live event", delta: "silent live event" },
      });
      await waitForFast(() => expect(gateway.liveEventRequests).toHaveLength(2));
      await live.emitTerminal(RUN_ID, {
        kind: "lifecycle",
        payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
      });
      await inference.start({
        runEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        turnId: "silent-inference",
        modelRef: MODEL_REF,
        context: { messages: [] },
        options: {},
      });

      expect(gateway.transcriptRequests).toHaveLength(2);
      expect(gateway.transcriptRequests[1]).toEqual(gateway.transcriptRequests[0]);
      expect(gateway.liveEventRequests).toHaveLength(3);
      expect(gateway.liveEventRequests[1]).toEqual(gateway.liveEventRequests[0]);
      expect(gateway.inferenceRequests).toHaveLength(2);
      expect(gateway.inferenceRequests[1]).toEqual(gateway.inferenceRequests[0]);
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(4);
    } finally {
      inference.dispose();
      live.dispose();
      await connection.stop();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
