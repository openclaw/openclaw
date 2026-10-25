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
  type WorkerTurnAdmissionParams,
  WorkerTurnAdmissionRequestFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
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
import { createUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { runExec } from "../process/exec.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as workerTranscriptRuntime from "./embedded-agent-transcript.runtime.js";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { WorkerAdmissionDeadlineExceededError } from "./worker-connection-contract.js";
import type { createWorkerConnection } from "./worker-connection.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { createWorkerLaunchDescriptorForTest } from "./worker-process.test-support.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";
import { WorkerLiveEventClient } from "./worker-rpc-live-event-client.js";
import { WorkerTranscriptCommitClient } from "./worker-rpc-transcript-client.js";
import {
  registerWorkerBackgroundExecLifecycleTests,
  registerWorkerExecEnvironmentFinalizationTests,
} from "./worker-runtime-background-exec.suite.js";
import { registerWorkerGitHubFailureTests } from "./worker-runtime-github-failures.suite.js";
import { registerWorkerNativeInferenceTests } from "./worker-runtime-native-inference.suite.js";
import { registerWorkerPermissionTests } from "./worker-runtime-permissions.suite.js";
import { registerWorkerPromptTests } from "./worker-runtime-prompt.suite.js";
import { registerWorkerReplayWindowTests } from "./worker-runtime-replay.suite.js";
import {
  registerWorkerGatewayToolAvailabilityTests,
  registerWorkerGatewayToolRpcTests,
  createWorkerToolSurfaceForTest,
  createWorkerHelloForTest,
  createWorkerConnectionForTest,
  buildWorkerExecToolCall,
  WorkerExecApprovalFixture,
  type WorkerExecFixtureOptions,
} from "./worker-tool-surface.test-support.js";
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
const BROWSER = {
  cdpUrl: "http://127.0.0.1:9222",
  launcherPath: "/usr/local/bin/openclaw-worker-browser",
};
function computerDescriptor(): NonNullable<WorkerLaunchDescriptor["assignment"]["computer"]> {
  return {
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
}

const RECONNECT_BACKOFF = { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const githubProfileDir = (stateDir: string, turnId: string) =>
  path.join(stateDir, "github-profiles", sha256(turnId).slice(0, 16));
const workerSessions = () =>
  listRunningSessions().filter((session) => session.scopeKey === `worker:${SESSION_ID}`);

type ToolCallPlan = { args: Record<string, unknown>; toolCallId: string; toolName: string };
const toolCall = (
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
): ToolCallPlan => ({ toolName, toolCallId, args });
const TOOL_PLANS = {
  "read-image": toolCall("read", "read-attachment", { path: "attachment.png" }),
  computer: toolCall("computer", "worker-screenshot", { action: "screenshot" }),
};
type InferencePlan =
  | "text"
  | "read-image"
  | "tool"
  | "safe-tool"
  | "background-tool"
  | "process-poll"
  | "process-kill"
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
  | ToolCallPlan;
type WorkerDoneMessage = Extract<WorkerInferenceTerminalOutcome, { type: "done" }>["message"];
type InferenceOutput = {
  event: (event: WorkerInferenceEventFrame["payload"]["event"]) => void;
  finish: (outcome: WorkerInferenceTerminalOutcome) => void;
};
const USAGE = createUsageFixture(2, 3, 5);

type FakeGatewayOptions = WorkerExecFixtureOptions & {
  admissionFailure?: "gateway-unavailable" | "invalid-credential" | "owner-epoch-mismatch";
  execApprovals?: Parameters<typeof saveExecApprovals>[0];
  inferencePlans?: InferencePlan[];
  outageOnInferenceCancel?: boolean;
  ignoreFirstAdmission?: boolean;
  ignoreHeartbeat?: boolean;
  silenceFirstTranscript?: boolean;
  silenceFirstLiveEvent?: boolean;
  silenceFirstInference?: boolean;
  dropSessionToolResponses?: number;
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
    usage: structuredClone(USAGE),
    stopReason,
    timestamp: Date.now(),
  };
}

class FakeWorkerGateway extends WorkerExecApprovalFixture {
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
  readonly turnAdmissionRequests: WorkerTurnAdmissionParams[] = [];
  readonly gatewayToolRequests: WorkerGatewayToolInvokeParams[] = [];
  readonly computerRequests: WorkerComputerParams[] = [];
  readonly applicationOrder: string[] = [];

  get messages() {
    return this.acceptedTranscriptRequests.flatMap((request) => request.messages);
  }

  waitForInferenceStart(): Promise<void> {
    return withTestTimeout(
      this.inferenceStarted.promise,
      WORKER_INFERENCE_START_TIMEOUT_MS,
      "worker inference start did not reach the fake Gateway",
    );
  }

  constructor(private readonly options: FakeGatewayOptions = {}) {
    super(options);
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
    this.disconnectClients();
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
      return this.handleConnect(socket, parsed);
    }
    if (Value.Check(WorkerHeartbeatRequestFrameSchema, parsed)) {
      return this.handleHeartbeat(socket, parsed);
    }
    if (Value.Check(WorkerTranscriptCommitRequestFrameSchema, parsed)) {
      return this.handleTranscript(socket, parsed);
    }
    if (Value.Check(WorkerLiveEventRequestFrameSchema, parsed)) {
      return this.handleLiveEvent(socket, parsed);
    }
    if (Value.Check(WorkerTurnAdmissionRequestFrameSchema, parsed)) {
      this.methods.push(parsed.method);
      this.turnAdmissionRequests.push(structuredClone(parsed.params));
      this.applicationOrder.push("admission");
      const lastTranscript = this.acceptedTranscriptRequests.at(-1);
      // This fixture starts with admitted input; only worker output advances its leaf.
      this.reply(socket, parsed.id, {
        outcome: "allow",
        baseLeafId: lastTranscript ? `leaf-${lastTranscript.seq}` : "leaf-base",
      });
      return;
    }
    if (Value.Check(WorkerInferenceStartRequestFrameSchema, parsed)) {
      return this.handleInference(socket, parsed);
    }
    if (Value.Check(WorkerInferenceCancelRequestFrameSchema, parsed)) {
      return this.handleInferenceCancel(socket, parsed);
    }
    if (isRecord(parsed) && parsed.type === "req" && typeof parsed.id === "string") {
      if (this.handleExecApproval(parsed, (id, payload) => this.reply(socket, id, payload))) {
        return;
      }
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
        if (this.options.computerCleanupFailure && closing) {
          this.send(socket, {
            type: "res",
            id: parsed.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "fixture desktop cleanup failed",
              details: { reason: "gateway-unavailable" },
            },
          });
        } else {
          this.reply(socket, parsed.id, {
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
          });
        }
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
      this.reject(
        socket,
        frame.id,
        "worker fixture rejected",
        { reason: this.options.admissionFailure },
        true,
      );
      return;
    }
    this.reply(
      socket,
      frame.id,
      createWorkerHelloForTest(
        frame.params.admission,
        this.toolSurface(),
        this.options.heartbeatIntervalMs,
      ),
    );
  }

  private handleHeartbeat(socket: WebSocket, frame: WorkerHeartbeatRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.ignoreHeartbeat) {
      return;
    }
    if (this.options.heartbeatFailure) {
      this.reject(socket, frame.id, "worker heartbeat rejected", {
        reason: this.options.heartbeatFailure,
      });
      return;
    }
    this.reply(socket, frame.id, {
      receivedAtMs: Date.now(),
      status: "ok",
      ownerEpoch: OWNER_EPOCH,
    });
  }

  private handleInferenceCancel(socket: WebSocket, frame: WorkerInferenceCancelRequestFrame): void {
    this.methods.push(frame.method);
    if (this.options.outageOnInferenceCancel) {
      this.unavailable = true;
      socket.terminate();
      return;
    }
    this.reply(socket, frame.id, { status: "cancelled" });
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
    this.reply(
      socket,
      id,
      request.toolId === "presence"
        ? {
            content: [{ type: "text", text: "Ada is online" }],
            details: { status: "ok", people: [{ name: "Ada" }] },
          }
        : {
            content: [{ type: "text", text: "child accepted" }],
            details: { status: "accepted", childSessionKey: "agent:main:cloud-child" },
          },
    );
  }

  private handleTranscript(socket: WebSocket, frame: WorkerTranscriptCommitRequestFrame): void {
    this.methods.push(frame.method);
    this.transcriptRequests.push(structuredClone(frame.params));
    if (this.options.silenceFirstTranscript && !this.droppedTranscript) {
      this.droppedTranscript = true;
      return;
    }
    this.acceptedTranscriptRequests.push(structuredClone(frame.params));
    this.applicationOrder.push(`transcript:${frame.params.seq}`);
    this.reply(socket, frame.id, {
      entryIds: frame.params.messages.map(
        (_message, index) => `entry-${frame.params.seq}-${index}`,
      ),
      newLeafId: `leaf-${frame.params.seq}`,
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
    if (this.options.liveFailure) {
      this.reject(socket, frame.id, "worker live event rejected", {
        reason: this.options.liveFailure,
      });
      return;
    }
    this.reply(socket, frame.id, { ackedSeq: frame.params.seq });
  }

  private handleInference(socket: WebSocket, frame: WorkerInferenceStartRequestFrame): void {
    this.methods.push(frame.method);
    this.inferenceRequests.push(structuredClone(frame.params));
    this.applicationOrder.push("inference");
    if (this.inferencePlanIndex === 0 && this.options.execApprovals) {
      saveExecApprovals(this.options.execApprovals);
    }
    this.inferenceStarted.resolve();
    if (this.options.silenceFirstInference && !this.droppedInference) {
      this.droppedInference = true;
      return;
    }
    this.reply(socket, frame.id, { status: "accepted" });
    const plan = this.options.inferencePlans?.[this.inferencePlanIndex] ?? "text";
    this.inferencePlanIndex += 1;
    const output = this.inferenceOutput(socket, frame.params);
    if (typeof plan === "object") {
      this.sendToolCallTurn(output, plan);
      return;
    }
    if (plan === "read-image" || plan === "computer") {
      return this.sendToolCallTurn(output, TOOL_PLANS[plan]);
    }
    if (plan === "hold") {
      return;
    }
    if (plan === "fence") {
      setTimeout(() => socket.close(1008, "owner-epoch-mismatch"), 5);
      return;
    }
    if (plan === "error" || plan === "cancelled") {
      output.finish({
        type: "error",
        reason: plan === "error" ? "provider-error" : "cancelled",
        message: plan === "error" ? "fixture provider failed" : "fixture inference cancelled",
      });
      return;
    }
    if (plan === "tool" || plan === "safe-tool" || plan === "background-tool") {
      this.sendToolTurn(output, {
        background: plan === "background-tool",
        safe: plan === "safe-tool",
      });
      return;
    }
    if (plan === "process-poll" || plan === "process-kill") {
      const processResult = this.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "exec",
      );
      const details = processResult?.role === "toolResult" ? processResult.details : undefined;
      this.sendToolCallTurn(output, {
        args: {
          action: plan === "process-poll" ? "poll" : "kill",
          sessionId: isRecord(details) ? details.sessionId : undefined,
        },
        toolCallId: plan,
        toolName: "process",
      });
      return;
    }
    if (plan === "burst-text" || plan === "oversized-text" || plan === "oversized-error") {
      this.sendBurstTextTurn(
        output,
        plan === "burst-text" ? 1_100 : 1_700,
        plan === "oversized-error" ? "error" : "done",
      );
      return;
    }
    if (plan === "empty-terminal") {
      this.sendEmptyTerminalTurn(output);
      return;
    }
    this.sendTextTurn(output, plan === "length" ? "length" : "stop");
  }

  private sendTurn(
    output: InferenceOutput,
    events: WorkerInferenceEventFrame["payload"]["event"][],
    outcome: () => WorkerInferenceTerminalOutcome,
  ): void {
    output.event({
      type: "start",
      resolvedModel: { api: "openai-responses", ...MODEL_REF },
      timestamp: Date.now(),
    });
    events.forEach(output.event);
    output.finish(outcome());
  }

  private sendBurstTextTurn(
    output: InferenceOutput,
    chunkCount = 1_100,
    terminal: "done" | "error" = "done",
  ): void {
    const chunk = "x".repeat(40);
    this.sendTurn(
      output,
      [
        { type: "text_start", contentIndex: 0 },
        ...Array.from({ length: chunkCount }, () => ({
          type: "text_delta" as const,
          contentIndex: 0,
          delta: chunk,
        })),
      ],
      () =>
        terminal === "error"
          ? {
              type: "error",
              reason: "provider-error",
              message: "fixture provider failed after streaming",
            }
          : {
              type: "done",
              message: assistantMessage([{ type: "text", text: chunk.repeat(chunkCount) }], "stop"),
            },
    );
  }

  private sendEmptyTerminalTurn(output: InferenceOutput): void {
    this.sendTurn(
      output,
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "discarded draft" },
      ],
      () => ({ type: "done", message: assistantMessage([], "stop") }),
    );
  }

  private sendTextTurn(output: InferenceOutput, stopReason: "stop" | "length" = "stop"): void {
    this.sendTurn(
      output,
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "worker reply" },
        { type: "text_end", contentIndex: 0 },
      ],
      () => ({
        type: "done",
        message: assistantMessage([{ type: "text", text: "worker reply" }], stopReason),
      }),
    );
  }

  private sendToolTurn(
    output: InferenceOutput,
    options: { background: boolean; safe: boolean },
  ): void {
    this.sendToolCallTurn(output, buildWorkerExecToolCall(this.options, options));
  }

  private sendToolCallTurn(output: InferenceOutput, tool: ToolCallPlan): void {
    const { args, toolCallId, toolName } = tool;
    const encodedArgs = JSON.stringify(args);
    this.sendTurn(
      output,
      [
        { type: "toolcall_start", contentIndex: 0, id: toolCallId, toolName },
        { type: "toolcall_delta", contentIndex: 0, delta: encodedArgs },
        { type: "toolcall_end", contentIndex: 0 },
      ],
      () => ({
        type: "done",
        message: assistantMessage(
          [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
          "toolUse",
        ),
      }),
    );
  }

  private inferenceOutput(socket: WebSocket, params: WorkerInferenceStartParams): InferenceOutput {
    const { runEpoch, sessionId, runId, turnId } = params;
    const identity = { runEpoch, sessionId, runId, turnId };
    let seq = 0;
    return {
      event: (event) =>
        this.send(socket, {
          type: "event",
          event: "worker.inference.event",
          payload: { ...identity, seq: ++seq, event },
        } satisfies WorkerInferenceEventFrame),
      finish: (outcome) =>
        this.send(socket, {
          type: "event",
          event: "worker.inference.terminal",
          payload: { ...identity, seq: ++seq, outcome },
        } satisfies WorkerInferenceTerminalFrame),
    };
  }

  private send(socket: WebSocket, frame: object): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  private reply(socket: WebSocket, id: string, payload: object): void {
    this.send(socket, { type: "res", id, ok: true, payload });
  }

  private reject(
    socket: WebSocket,
    id: string,
    message: string,
    details: object,
    retryable?: true,
  ): void {
    this.send(socket, {
      type: "res",
      id,
      ok: false,
      error: { code: "INVALID_REQUEST", message, details, ...(retryable ? { retryable } : {}) },
    });
  }
}

function descriptor(socketPath: string, workspaceDir: string): WorkerLaunchDescriptor {
  return createWorkerLaunchDescriptorForTest({
    connectionEndpoint: { kind: "unix", socketPath },
    admission: {
      environmentId: "worker-environment",
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      ownerEpoch: OWNER_EPOCH,
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
      workspaceDir,
      modelRef: MODEL_REF,
      inferenceOptions: { reasoning: "off" },
      transcript: { baseLeafId: "leaf-base", nextSeq: 3 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: {
        allowedToolNames: ["read", "write", "edit", "apply_patch", "exec", "process"],
        exec: { host: "gateway", security: "full", ask: "off" },
      },
    },
  });
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

async function withConnection(
  options: FakeGatewayOptions,
  run: (
    connection: ReturnType<typeof createWorkerConnection>,
    gateway: FakeWorkerGateway,
  ) => Promise<void>,
  connectionOptions: Partial<Parameters<typeof createWorkerConnection>[0]> = {},
) {
  const { gateway, launch } = await setup(options);
  const connection = createWorkerConnectionForTest(launch, connectionOptions);
  try {
    await run(connection, gateway);
  } finally {
    await connection.stop();
  }
}

function nextTurn(launch: WorkerLaunchDescriptor, gateway: FakeWorkerGateway, index: number) {
  const next = structuredClone(launch);
  next.assignment.runId = `worker-next-run-${index}`;
  next.assignment.turnId = `worker-next-turn-${index}`;
  next.assignment.operationalRunInstance = createOperationalRunInstanceRef(next.assignment.runId);
  next.assignment.agentRuntimeIdentityToken = `next-test-runtime-token-${index}`;
  next.admission.credential = `next-test-worker-credential-${index}`;
  next.assignment.initialMessages = gateway.messages;
  return next;
}

function managedCommand() {
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
  return {
    results,
    idleReady,
    command,
    settled,
    scopeKey,
    send(this: void, launch: WorkerLaunchDescriptor, idleRetention = false) {
      input.write(`${JSON.stringify(buildWorkerProcessTurn(launch, idleRetention))}\n`);
      return launch.assignment.turnId;
    },
    cancel(this: void, turnId: string) {
      input.write(`${JSON.stringify({ type: "cancel", turnId })}\n`);
    },
    waitResults(this: void, count: number) {
      return waitForFast(() => expect(results).toHaveLength(count), { timeout: 30_000 });
    },
    async close(this: void) {
      input.end();
      try {
        await command;
      } finally {
        supervisor.cancelScope(scopeKey, "manual-cancel");
        await waitForExecScope(scopeKey);
      }
    },
  };
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
  const messages = gateway.messages;
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
  launch.assignment.browser = { ...BROWSER };
  launch.assignment.computer = computerDescriptor();
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
    launch.assignment.browser = { ...BROWSER };
    const createSession =
      outcome === "setup"
        ? vi
            .spyOn(agentSessionSdk, "createAgentSession")
            .mockRejectedValueOnce(new Error("fixture setup failed"))
        : undefined;
    browserRuntimeMocks.dispose.mockRejectedValueOnce(new Error("fixture browser cleanup failed"));
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
        expect(gateway.liveEventRequests.at(-1)?.event.payload).toMatchObject({
          error: expect.stringContaining("fixture provider failed"),
        });
      }
      expect(browserRuntimeMocks.dispose).toHaveBeenCalledOnce();
    } finally {
      createSession?.mockRestore();
    }
  },
);

it.each(["error", "cancelled"] as const)(
  "keeps desktop images through RPC, transcript, and inference before failed cleanup (%s)",
  async (terminal) => {
    const computerSnapshot = createNoisyPngBuffer(512, 512).toString("base64");
    expect(computerSnapshot.length).toBeGreaterThan(64 * 1024);
    const { gateway, launch } = await setup({
      inferencePlans: ["computer", terminal],
      computerSnapshot,
      computerCleanupFailure: true,
    });
    launch.assignment.toolAuthority.allowedToolNames = ["computer"];
    launch.assignment.computer = computerDescriptor();

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
    const screenshot = gateway.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "computer",
    );
    expect(screenshot).toMatchObject({
      isError: false,
      content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    });
    if (screenshot?.role !== "toolResult") {
      throw new Error("Expected computer tool result");
    }
    const image = screenshot.content.find((part) => part.type === "image");
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
    const finalEvent = gateway.liveEventRequests.at(-1)?.event;
    expect(finalEvent).toMatchObject({
      kind: "lifecycle",
      payload: {
        phase: "finishing",
        replayInvalid: true,
        stopReason: terminal === "cancelled" ? "aborted" : "error",
      },
    });
    for (const text of terminal === "cancelled"
      ? ["fixture inference cancelled", "fixture desktop cleanup failed"]
      : [
          "fixture provider failed",
          "computer: session desktop cleanup failed | fixture desktop cleanup failed",
        ]) {
      expect(finalEvent?.payload).toHaveProperty("error", expect.stringContaining(text));
    }
  },
);

it.each([
  { authority: ["browser"] as const, browser: undefined },
  {
    authority: ["read"] as const,
    browser: BROWSER,
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
  ["sessions_spawn", "call-durable-spawn", { task: "start a nested cloud child" }, true],
  ["portal", "call-portal-once", { action: "open", port: 3000 }, false],
] as const)(
  "respects %s replay policy after response loss",
  async (toolId, toolCallId, args, replay) => {
    await withConnection(
      { dropSessionToolResponses: replay ? 2 : 1 },
      async (connection, gateway) => {
        let readyCalls = 0;
        connection.onStateChange((state) => {
          if (state.kind === "ready") {
            readyCalls += 1;
          }
        });
        await connection.start();
        const request = { generation: "runtime-surface", toolId, toolCallId, arguments: args };
        if (replay) {
          await expect(
            connection.invokeGatewayTool(request, { replay: true }),
          ).resolves.toMatchObject({
            ok: true,
            payload: { content: [{ type: "text", text: "child accepted" }] },
          });
          expect({ connections: gateway.connectionCount, readyCalls }).toEqual({
            connections: 3,
            readyCalls: 3,
          });
          expect(gateway.gatewayToolRequests).toEqual([request, request, request]);
        } else {
          await expect(connection.invokeGatewayTool(request)).rejects.toMatchObject({
            name: "WorkerConnectionInterruptedError",
          });
          expect(gateway.gatewayToolRequests).toEqual([request]);
        }
      },
      { reconnectBackoff: RECONNECT_BACKOFF },
    );
  },
);

it("requires authoritative terminal delivery after degrading preview live events", async () => {
  const { gateway, launch } = await setup({ liveFailure: "capacity-exceeded" });

  await expect(runWorkerDescriptor(launch)).rejects.toThrow("worker live event rejected");

  expect(gateway.inferenceRequests).toHaveLength(1);
  expect(gateway.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(gateway.liveEventRequests.length).toBeGreaterThanOrEqual(2);
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
    const connection = createWorkerConnectionForTest(launch);
    // Production formats the last failure into the deadline message
    // (WorkerConnection.failAdmissionDeadline); model that here.
    const deadline = new WorkerAdmissionDeadlineExceededError(
      "no admission after 3 attempts to gateway.sock: connect ECONNREFUSED",
    );
    const start = vi.spyOn(connection, "start");
    if (phase === "initial admission") {
      start.mockRejectedValue(deadline);
    } else {
      start.mockResolvedValue(
        createWorkerHelloForTest(launch.admission, {
          generation: "surface",
          presentation: createToolSurfacePresentationForTest(),
          tools: [],
          policy: prepareCoreToolPolicy({}),
        }),
      );
    }
    const connectionModule = await import("./worker-connection.js");
    const factory = vi
      .spyOn(connectionModule, "createWorkerConnection")
      .mockImplementation((options) => {
        options.onConnectionFailure?.(new Error("connect ECONNREFUSED"));
        return connection;
      });
    const embeddedRuntime = await import("./embedded-agent.runtime.js");
    const runTurn = vi.spyOn(embeddedRuntime, "runWorkerEmbeddedTurn").mockRejectedValue(deadline);
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
    if (plan === "oversized-text") {
      expect(assistant).toMatchObject({
        errorMessage: "Worker inference result exceeds the transcript message limit.",
        usage: USAGE,
      });
    }
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
    const { send, cancel, waitResults, results, settled, scopeKey, close } = managedCommand();

    try {
      send(launch);
      await waitResults(1);
      expect(results[0]).toMatchObject({
        turnId: launch.assignment.turnId,
        result: { status: "completed" },
        retainWorker: true,
      });
      const running = workerSessions();
      expect(running).toHaveLength(1);
      const sessionId = running[0]!.id;
      const messages = gateway.messages;
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("still running") }],
      });
      expect(JSON.stringify(messages.at(-1))).toContain(sessionId);
      expect(gateway.inferenceRequests).toHaveLength(2);
      expect(
        gateway.liveEventRequests.findLast(({ event }) => event.kind === "assistant"),
      ).toMatchObject({ event: { payload: { text: expect.stringContaining("still running") } } });
      expect(settled).not.toHaveBeenCalled();
      if (processState === "completed") {
        releaseBackground.resolve();
        await waitForExecScope(scopeKey);
        await waitForFast(() => expect(workerSessions()).toHaveLength(0));
        expect(settled).not.toHaveBeenCalled();
      }

      const nextTurnId = send(nextTurn(launch, gateway, 2));
      if (processState === "cancelled") {
        await waitForFast(() => expect(gateway.inferenceRequests).toHaveLength(3), {
          timeout: 30_000,
        });
        cancel(nextTurnId);
        await waitResults(2);
        expect(results[1]).toMatchObject({
          result: { status: "failed", reason: "turn-failed" },
          retainWorker: true,
        });
        send(nextTurn(launch, gateway, 3));
      }
      const turnCount = processState === "cancelled" ? 3 : 2;
      await waitResults(turnCount);
      expect(gateway.connectionCount).toBe(turnCount);
      const processResults = gateway.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "process",
      );
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
      try {
        await close();
      } finally {
        if (completionServer) {
          await new Promise<void>((resolve, reject) => {
            completionServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
      }
    }
    expect(workerSessions()).toHaveLength(0);
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
    for (const [name, args] of [
      ["process", { action: "list" }],
      ["exec", { command: "echo stale-worker" }],
    ] as const) {
      const tool = tools.find((entry) => entry.name === name)!;
      await expect(tool.execute(`retained-${name}`, args)).rejects.toMatchObject({
        name: "AbortError",
      });
    }
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
  await waitForFast(() => expect(workerSessions()).toHaveLength(0), { timeout: 7_000 });
});

it("executes coding tools locally without reading the preexisting auth profile", async () => {
  const { gateway, workspaceDir, launch } = await setup({ inferencePlans: ["tool", "text"] });
  const trapStateDir = path.join(workspaceDir, "state-trap");
  const authDir = path.join(trapStateDir, "agents", "main", "agent");
  const configTrap = path.join(workspaceDir, "config-trap");
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "auth-profiles.json"), "not valid json", "utf8");
  await mkdir(configTrap);
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: trapStateDir, OPENCLAW_CONFIG_PATH: configTrap },
    async () => {
      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    },
  );

  await expect(readFile(path.join(workspaceDir, "local-proof.txt"), "utf8")).resolves.toBe(
    "worker-local",
  );
  expect(gateway.inferenceRequests).toHaveLength(2);
  expect(
    gateway.inferenceRequests[1]?.context.messages.some((message) => message.role === "toolResult"),
  ).toBe(true);
  expect(
    gateway.methods.every((method) => method.startsWith("worker.") || method === "connect"),
  ).toBe(true);
});

// The probe uses a POSIX shell; Windows launches exec through PowerShell.
it.skipIf(process.platform === "win32")(
  "binds the turn GitHub identity and checkout to real exec without publishing its token",
  async () => {
    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: ["tool", "text"],
      execCommand: [
        'printf "%s" "$GH_TOKEN" | if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi | cut -d " " -f1',
        'printf "github-token=%s\\n" "$GITHUB_TOKEN"',
        'printf "helpers-start\\n"',
        "git config --get-all credential.helper",
        'printf "helpers-end\\n"',
        "git config --show-scope --get-all credential.helper",
        "git symbolic-ref HEAD",
        "git remote get-url origin",
        'printf "profile=%s\\n" "$GH_CONFIG_DIR"',
      ].join("; "),
    });
    const binding = {
      token: "worker-turn-fixture-token",
      login: "worker-fixture",
      branch: "openclaw/session-fixture",
      remoteUrl: "https://github.com/openclaw/worker-fixture.git",
    };
    launch.assignment.github = binding;
    const environment = await createWorkerRuntimeEnvironment(SESSION_ID);
    try {
      const git = async (args: string[]) =>
        await runExec("git", ["-C", workspaceDir, ...args], {
          timeoutMs: 10_000,
          maxBuffer: 4_096,
          logOutput: false,
        });
      await git(["init", "--quiet", "--initial-branch=openclaw-worker"]);
      await git([
        "-c",
        "user.name=Worker Fixture",
        "-c",
        "user.email=worker@openclaw.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "Worker base",
      ]);
      const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(workspaceDir, ".git", "shallow"), `${baseCommit}\n`);

      await expect(
        runWorkerDescriptor(launch, { environmentStateDir: environment.stateDir }),
      ).resolves.toMatchObject({ status: "completed" });

      const toolResult = gateway.inferenceRequests[1]?.context.messages
        .filter((message) => message.role === "toolResult")
        .find((message) => message.toolName === "exec");
      expect(toolResult).toMatchObject({ isError: false });
      const profileDir = githubProfileDir(environment.stateDir, launch.assignment.turnId);
      const output =
        toolResult?.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n") ?? "";
      expect(output).toContain(
        [sha256(binding.token), "github-token=", "helpers-start"].join("\n"),
      );
      expect(output).toContain(
        [`refs/heads/${binding.branch}`, binding.remoteUrl, `profile=${profileDir}`].join("\n"),
      );
      expect(
        output
          .split("\n")
          .filter((line) => line.startsWith("command\t"))
          .map((line) => line.slice("command\t".length)),
      ).toEqual(["", "!gh auth git-credential"]);
      const helpers = output.split("helpers-start\n")[1]?.split("\nhelpers-end")[0]?.split("\n");
      // Git lists inherited helpers too; an empty value resets the effective helper list.
      expect(helpers?.slice(helpers.lastIndexOf(""))).toEqual(["", "!gh auth git-credential"]);
      expect((await stat(profileDir)).mode & 0o777).toBe(0o700);
      const hostsPath = path.join(profileDir, "hosts.yml");
      expect((await stat(hostsPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(hostsPath, "utf8")).toContain(binding.login);
      expect(JSON.stringify(gateway.transcriptRequests)).not.toContain(binding.token);
      expect(JSON.stringify(gateway.liveEventRequests)).not.toContain(binding.token);
    } finally {
      await environment.close();
    }
  },
);

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
    const { send, waitResults, results, idleReady, command, settled, scopeKey, close } =
      managedCommand();
    try {
      send(launch, true);
      await waitResults(1);
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
      const next = nextTurn(launch, gateway, 2);
      next.assignment.github = {
        login: "worker-b",
        token: "worker-turn-b-token",
        branch: "openclaw/session-fixture",
      };
      send(next, true);
      await waitResults(2);
      expect(results[1]).toMatchObject({
        turnId: next.assignment.turnId,
        result: { status: "completed" },
        retainWorker: true,
      });
      const execResult = gateway.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "exec",
      );
      expect(execResult).toMatchObject({
        isError: false,
        content: [{ type: "text", text: expect.stringContaining("turn-b-completed") }],
      });
      expect(settled).not.toHaveBeenCalled();

      const nextProfileDir = githubProfileDir(stateDir, next.assignment.turnId);
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
      await close();
    }
  },
);

registerWorkerGitHubFailureTests({ setup, sessionId: SESSION_ID });

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

describe("worker reconnect clients", () => {
  it("isolates ready listener failures while admitting the worker and starting heartbeats", async () => {
    await withConnection({ heartbeatIntervalMs: 1 }, async (connection, gateway) => {
      let healthyReadyCalls = 0;
      connection.onReady(() => {
        throw new Error("induced ready observer failure");
      });
      connection.onReady(() => {
        healthyReadyCalls += 1;
      });
      await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
      expect(healthyReadyCalls).toBe(1);
      await waitForFast(() => expect(gateway.methods).toContain("worker.heartbeat"));
    });
  });

  it.each([
    ["admission", { ignoreFirstAdmission: true }, { admissionTimeoutMs: 25 }],
    ["heartbeat", { ignoreHeartbeat: true, heartbeatIntervalMs: 1 }, { requestTimeoutMs: 25 }],
  ] as const)("times out a silent %s and reconnects", async (_phase, gatewayOptions, options) => {
    await withConnection(
      gatewayOptions,
      async (connection, gateway) => {
        await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
        await waitForFast(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2));
      },
      { ...options, reconnectBackoff: RECONNECT_BACKOFF },
    );
  });

  it("replays exact RPC payloads after silent response timeouts", async () => {
    const { gateway, launch } = await setup({
      silenceFirstTranscript: true,
      silenceFirstLiveEvent: true,
      silenceFirstInference: true,
    });
    const connection = createWorkerConnectionForTest(launch, {
      requestTimeoutMs: 40,
      reconnectBackoff: RECONNECT_BACKOFF,
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
