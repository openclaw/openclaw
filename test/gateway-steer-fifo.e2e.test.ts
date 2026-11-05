import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
import type { ChatPendingInputsPage } from "../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClient, type GatewayClientOptions } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { RUNTIME_CONTEXT_HEADER } from "../src/llm/types.js";
import { GatewayChatClient } from "../src/tui/gateway-chat.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  writeRestartToolCalls,
  writeRestartPlugin,
  restartModelConfig,
  readRestartTrace as readTrace,
} from "./gateway-restart.test-support.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

type FirstResponseKind = "final" | "sequential-tools" | "tool";
type ModelRequest = { body: Record<string, unknown> };
type MockModelServer = Awaited<ReturnType<typeof startMockModelServer>>;
type AgentEvent = {
  runId?: string;
  stream?: string;
  data?: { phase?: string };
};
type GatewayFixture = Awaited<ReturnType<typeof createGatewayFixture>>;

type SteeringAdmissionFixture = {
  pluginDir: string;
  receiptPath: string;
};

type SteeringToolsFixture = {
  pluginDir: string;
  releasePath: string;
  tracePath: string;
};
type SteeringGateMode = "preflight" | "execute";

const TEST_TIMEOUT_MS = 180_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;
const STEERING_PLUGIN_ID = "gateway-steering-tools";
const STEERING_ADMISSION_PLUGIN_ID = "gateway-steering-admission";
const STEERING_GATE_TOOL = "steering_gate";
const STEERING_TAIL_TOOL = "steering_tail";
const instances: OpenClawTestInstance[] = [];
const clients: GatewayChatClient[] = [];
const diagnosticsClients: GatewayClient[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  // Finish each ownership layer before closing the resources beneath it.
  for (const tasks of [
    () => clients.splice(0).map((client) => client.stop()),
    () => diagnosticsClients.splice(0).map((client) => client.stopAndWait()),
    () => instances.splice(0).map((instance) => instance.cleanup()),
    () => modelServers.splice(0).map((server) => server.stop()),
    () => cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ]) {
    const results = await Promise.allSettled(tasks());
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway steer FIFO cleanup failed");
  }
});

function writeToolsResponse(res: ServerResponse, id: string, tools: [string, string][]): void {
  const items = tools.map(([key, name]) => ({
    type: "function_call",
    id: `fc_${key}`,
    call_id: `call_${key}`,
    name,
    arguments: "{}",
    status: "completed",
  }));
  writeRestartToolCalls(res, id, items, { argumentEvent: "done" });
}

async function startMockModelServer(holdSecondResponse = false) {
  const requests: ModelRequest[] = [];
  const firstResponse = createDeferred();
  const secondResponse = createDeferred();
  let firstResponseKind: FirstResponseKind = "final";
  const server = await startOpenAiResponsesModelServer({
    modelId: "steer-fifo",
    bindError: "steer FIFO model server did not bind",
    onRequest: async (req, res) => {
      const body = await readRequestText(req);
      requests.push({ body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
      const requestIndex = requests.length;
      if (requestIndex === 1) {
        await firstResponse.promise;
        if (res.destroyed) {
          return;
        }
        if (firstResponseKind !== "final") {
          writeToolsResponse(
            res,
            firstResponseKind === "tool"
              ? "resp_steer_fifo_tool"
              : "resp_steer_fifo_sequential_tools",
            firstResponseKind === "tool"
              ? [["steer_fifo_status", "session_status"]]
              : [
                  ["steering_gate", STEERING_GATE_TOOL],
                  ["steering_tail", STEERING_TAIL_TOOL],
                ],
          );
          return;
        }
      }
      if (requestIndex === 2 && holdSecondResponse) {
        await secondResponse.promise;
        if (res.destroyed) {
          return;
        }
      }
      writeOpenAiResponsesText(res, {
        text: `TURN_${requestIndex}_COMPLETE`,
        messageId: `msg_steer_fifo_${requestIndex}`,
        responseId: `resp_steer_fifo_${requestIndex}`,
      });
    },
  });
  let stopped = false;
  return {
    baseUrl: server.baseUrl,
    requests,
    releaseFirst: (kind: FirstResponseKind) => {
      firstResponseKind = kind;
      firstResponse.resolve();
    },
    releaseSecond: () => secondResponse.resolve(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      firstResponse.resolve();
      secondResponse.resolve();
      await server.close();
    },
  };
}

async function writeSteeringToolsPlugin(
  fixtureDir: string,
  gateMode: SteeringGateMode,
): Promise<SteeringToolsFixture> {
  const pluginDir = path.join(fixtureDir, "steering-tools-plugin");
  const releasePath = path.join(fixtureDir, "steering-gate.release");
  const tracePath = path.join(fixtureDir, "steering-tools.trace");
  await writeRestartPlugin(
    pluginDir,
    {
      id: STEERING_PLUGIN_ID,
      name: "Gateway Steering Tools",
      activation: { onStartup: true },
      contracts: { tools: [STEERING_GATE_TOOL, STEERING_TAIL_TOOL] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    `import { access, appendFile } from "node:fs/promises";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trace = (event) => appendFile(${JSON.stringify(tracePath)}, event + "\\n", "utf8");
async function waitForRelease() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(${JSON.stringify(releasePath)});
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(20);
  }
  throw new Error("steering gate release timed out");
}
const result = (text) => ({ content: [{ type: "text", text }], details: {} });
export default {
  id: ${JSON.stringify(STEERING_PLUGIN_ID)},
  register(api) {
    const preflight = ${JSON.stringify(gateMode === "preflight")};
    if (preflight) api.on("before_tool_call", async (event) => {
      if (event.toolName !== ${JSON.stringify(STEERING_GATE_TOOL)}) return;
      await trace("preflight-start");
      await waitForRelease();
      await trace("preflight-end");
    });
    const tool = (name, label, description, execute) => api.registerTool({
      name, label, description, execute,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      executionMode: "sequential",
    });
    tool(${JSON.stringify(STEERING_GATE_TOOL)}, "Steering Gate", "Wait for the steering gateway test release file.", async () => {
      if (preflight) await trace("gate-executed");
      else {
        await trace("gate-execute-start");
        await waitForRelease();
        await trace("gate-execute-end");
      }
      return result("steering gate completed");
    });
    tool(${JSON.stringify(STEERING_TAIL_TOOL)}, "Steering Tail", "Record if the steering tail executes unexpectedly.", async () => {
      await trace("tail-executed");
      return result("steering tail executed");
    });
  },
};
`,
  );
  return { pluginDir, releasePath, tracePath };
}

async function writeSteeringAdmissionPlugin(
  fixtureDir: string,
  marker: string,
): Promise<SteeringAdmissionFixture> {
  // The isolated Gateway child owns this observer of the real, successful admission.
  const pluginDir = path.join(fixtureDir, "steering-admission-plugin");
  const receiptPath = path.join(fixtureDir, "steering-admission.trace");
  await writeRestartPlugin(
    pluginDir,
    {
      id: STEERING_ADMISSION_PLUGIN_ID,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    [
      'import { appendFileSync } from "node:fs";',
      'import { Agent } from "openclaw/plugin-sdk/agent-core";',
      "export default {",
      `  id: ${JSON.stringify(STEERING_ADMISSION_PLUGIN_ID)},`,
      "  register() {",
      "    const admit = Agent.prototype.admitSteeringMessage;",
      "    Agent.prototype.admitSteeringMessage = function (message) {",
      "      const notify = admit.call(this, message);",
      "      return () => {",
      "        notify();",
      `        if (message.role === "user" && JSON.stringify(message.content).includes(${JSON.stringify(marker)})) {`,
      `          appendFileSync(${JSON.stringify(receiptPath)}, ${JSON.stringify(`${marker}\n`)});`,
      "        }",
      "      };",
      "    };",
      "  },",
      "};",
    ].join("\n"),
  );
  return { pluginDir, receiptPath };
}

function createConfig(params: {
  fixtureDir: string;
  modelServer: MockModelServer;
  steeringTools?: SteeringToolsFixture;
  steeringAdmission?: SteeringAdmissionFixture;
}): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(
    `${params.modelServer.baseUrl}/v1`,
    "steer-fifo",
  );
  const steeringTools = params.steeringTools;
  const modelConfig = restartModelConfig(provider, path.join(params.fixtureDir, "workspace"), {
    timeoutSeconds: undefined,
  });
  const fixturePlugins = [
    ...(steeringTools ? [{ id: STEERING_PLUGIN_ID, dir: steeringTools.pluginDir }] : []),
    ...(params.steeringAdmission
      ? [{ id: STEERING_ADMISSION_PLUGIN_ID, dir: params.steeringAdmission.pluginDir }]
      : []),
  ];
  return {
    ...modelConfig,
    plugins:
      fixturePlugins.length > 0
        ? {
            enabled: true,
            allow: fixturePlugins.map(({ id }) => id),
            load: { paths: fixturePlugins.map(({ dir }) => dir) },
            entries: Object.fromEntries(fixturePlugins.map(({ id }) => [id, { enabled: true }])),
            slots: { memory: "none" },
          }
        : { slots: { memory: "none" } },
    agents: {
      ...modelConfig.agents,
      entries: { main: { model: { primary: provider.modelRef }, skills: [] } },
    },
    tools: steeringTools
      ? {
          profile: "minimal",
          // This scripted provider emits direct calls to the steering fixture tools.
          codeMode: false,
          toolSearch: false,
          alsoAllow: [STEERING_GATE_TOOL, STEERING_TAIL_TOOL],
        }
      : { profile: "minimal" },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

async function connectDiagnosticsClient(
  instance: OpenClawTestInstance,
  cliMode = false,
  onEvent?: GatewayClientOptions["onEvent"],
): Promise<GatewayClient> {
  const hello = createDeferred();
  const gatewayUrl = new URL(instance.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  // UI diagnostics share the TUI identity; CLI requests own a separate connection.
  const options: GatewayClientOptions = {
    url: instance.url,
    origin: cliMode ? undefined : gatewayUrl.origin,
    token: "steer-fifo-token",
    clientName: cliMode ? GATEWAY_CLIENT_NAMES.CLI : GATEWAY_CLIENT_NAMES.TUI,
    clientDisplayName: "steer-fifo-e2e-diagnostics",
    mode: cliMode ? GATEWAY_CLIENT_MODES.CLI : GATEWAY_CLIENT_MODES.UI,
    deviceIdentity: cliMode ? null : undefined,
    sharedStateMode: cliMode ? "read-only" : undefined,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [
      GATEWAY_CLIENT_CAPS.AGENT_KIND,
      GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS,
      GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    ],
    requestTimeoutMs: 30_000,
    onHelloOk: () => hello.resolve(),
    onConnectError: (error) => hello.reject(error),
    onClose: (code, reason) => hello.reject(new Error(`Gateway closed ${code}: ${reason}`)),
    onEvent,
  };
  const client = new GatewayClient(options);
  diagnosticsClients.push(client);
  client.start();
  await hello.promise;
  return client;
}

async function createGatewayFixture(
  name: string,
  options: {
    withSteeringTools?: boolean;
    steeringGateMode?: SteeringGateMode;
    cliMode?: boolean;
    holdSecondResponse?: boolean;
    observeSteering?: string;
  } = {},
) {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), `openclaw-${name}-`));
  cleanupDirs.push(fixtureDir);
  const steeringTools = options.withSteeringTools
    ? await writeSteeringToolsPlugin(fixtureDir, options.steeringGateMode ?? "execute")
    : undefined;
  const steeringAdmission = options.observeSteering
    ? await writeSteeringAdmissionPlugin(fixtureDir, options.observeSteering)
    : undefined;
  const modelServer = await startMockModelServer(options.holdSecondResponse);
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    gatewayToken: "steer-fifo-token",
    config: createConfig({ fixtureDir, modelServer, steeringTools, steeringAdmission }),
    env: {
      OPENCLAW_LOG_LEVEL: "debug",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  instances.push(instance);
  await instance.startGateway();
  const events: AgentEvent[] = [];
  const chatErrors: Array<{ errorMessage?: string; runId?: string; state: "error" }> = [];
  const chatFinalRunIds: string[] = [];
  const client = new GatewayChatClient({
    url: instance.url,
    token: "steer-fifo-token",
  });
  clients.push(client);
  const onEvent: GatewayChatClient["onEvent"] = ({ event, payload }) => {
    if (event === "agent" && payload && typeof payload === "object") {
      const agentEvent = payload as AgentEvent;
      events.push(agentEvent);
    }
    if (event === "chat" && payload && typeof payload === "object") {
      const chat = payload as { errorMessage?: unknown; runId?: unknown; state?: unknown };
      if (chat.state === "error") {
        chatErrors.push({
          state: "error",
          ...(typeof chat.runId === "string" ? { runId: chat.runId } : {}),
          ...(typeof chat.errorMessage === "string"
            ? { errorMessage: chat.errorMessage.replaceAll("steer-fifo-token", "[REDACTED]") }
            : {}),
        });
      } else if (chat.state === "final" && typeof chat.runId === "string") {
        chatFinalRunIds.push(chat.runId);
      }
    }
  };
  client.onEvent = options.cliMode ? undefined : onEvent;
  client.start();
  await client.waitForReady();
  await client.subscribeSessionEvents();
  const diagnosticsClient = await connectDiagnosticsClient(
    instance,
    options.cliMode,
    options.cliMode ? onEvent : undefined,
  );
  if (options.cliMode) {
    await diagnosticsClient.request("sessions.subscribe", {});
  }
  return {
    client,
    diagnosticsClient,
    instance,
    modelServer,
    events,
    chatErrors,
    chatFinalRunIds,
    sessionKey: `agent:main:${name}`,
    ...(steeringTools ? { steeringTools } : {}),
    ...(steeringAdmission ? { steeringAdmission } : {}),
  };
}

async function sendChat(fixture: GatewayFixture, message: string, runId: string) {
  return await fixture.client.sendChat({
    sessionKey: fixture.sessionKey,
    message,
    deliver: false,
    runId,
  });
}

function directChat(
  fixture: GatewayFixture,
  message: string,
  idempotencyKey: string,
  queueMode?: "steer" | "followup",
) {
  return fixture.diagnosticsClient.request<{ runId: string; status?: string }>("chat.send", {
    sessionKey: fixture.sessionKey,
    message,
    deliver: false,
    idempotencyKey,
    ...(queueMode ? { queueMode } : {}),
  });
}

function redactedFixtureLogs(instance: OpenClawTestInstance): string {
  return instance
    .logs()
    .replaceAll("steer-fifo-token", "[REDACTED]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(["']?apiKey["']?\s*[:=]\s*)["'][^"']+["']/giu, "$1[REDACTED]")
    .slice(-12_000);
}

async function sendHeldTurn(fixture: GatewayFixture, directSteer = false) {
  // Direct chat.send steering retains this connection's admitted authority.
  // The TUI path below exercises follow-up queue admission instead.
  const first = directSteer
    ? await directChat(fixture, "INITIAL_HELD_TURN", "initial-held-turn")
    : await sendChat(fixture, "INITIAL_HELD_TURN", "initial-held-turn");
  expect(first.status).toBe("started");
  try {
    await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(1), WAIT_OPTS);
  } catch (error) {
    throw new Error(
      `initial chat turn did not reach the mock provider\n` +
        `chat errors=${JSON.stringify(fixture.chatErrors)}\n` +
        redactedFixtureLogs(fixture.instance),
      { cause: error },
    );
  }
  return first;
}

async function queueSteer(fixture: GatewayFixture, marker = "QUEUED_STEER_A") {
  const baseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
    "diagnostics.stability",
    {
      type: "message.queued",
      limit: 1,
    },
  );
  const result = await sendChat(fixture, marker, `run-${marker.toLowerCase()}`);
  expect(result.status).toBe("started");
  await vi.waitFor(async () => {
    const snapshot = await fixture.diagnosticsClient.request<{
      events?: Array<{
        queueDepth?: number;
        source?: string;
        type?: string;
      }>;
    }>("diagnostics.stability", {
      type: "message.queued",
      sinceSeq: baseline.lastSeq ?? 0,
      limit: 20,
    });
    expect(snapshot.events ?? []).toContainEqual(
      expect.objectContaining({ type: "message.queued", source: "followup-queue-steer" }),
    );
    if (fixture.steeringAdmission) {
      // Parking precedes async authority preparation; release tools only after runtime admission.
      expect(await readTrace(fixture.steeringAdmission.receiptPath)).toContain(marker);
    }
    expect(fixture.modelServer.requests).toHaveLength(1);
  }, WAIT_OPTS);
  return result;
}

async function queueOrdinaryFollowup(
  fixture: GatewayFixture,
  marker = "ORDINARY_MESSAGE_B",
): Promise<void> {
  const runId = `run-${marker.toLowerCase()}`;
  const result = await directChat(fixture, marker, runId, "followup");
  expect(result).toMatchObject({ runId, status: "started" });
  await vi.waitFor(async () => {
    const history = await fixture.diagnosticsClient.request<{
      pendingInputs?: ChatPendingInputsPage;
    }>("chat.history", { sessionKey: fixture.sessionKey, limit: 1 });
    expect(history.pendingInputs?.items).toEqual([
      expect.objectContaining({ runId, state: "queued", queued: true }),
    ]);
    expect(fixture.chatFinalRunIds).not.toContain(runId);
    expect(fixture.modelServer.requests).toHaveLength(1);
  }, WAIT_OPTS);
}

async function waitForRunTerminal(fixture: GatewayFixture, runId: string): Promise<void> {
  await vi.waitFor(
    () =>
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          runId,
          stream: "lifecycle",
          data: expect.objectContaining({ phase: "end" }),
        }),
      ),
    WAIT_OPTS,
  );
}

async function waitForSessionIdle(fixture: GatewayFixture, sinceSeq: number): Promise<void> {
  await vi.waitFor(async () => {
    const snapshot = await fixture.diagnosticsClient.request<{
      events?: Array<{ outcome?: string; queueDepth?: number; type?: string }>;
    }>("diagnostics.stability", {
      type: "session.state",
      sinceSeq,
      limit: 20,
    });
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({ type: "session.state", outcome: "idle", queueDepth: 0 }),
    );
  }, WAIT_OPTS);
  await setImmediate();
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n")
    : "";
}

function responseInputItems(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  const input = request?.body.input;
  return Array.isArray(input) ? input.filter(isRecord) : [];
}

function userInputs(request: ModelRequest | undefined): string[] {
  const input = request?.body.input;
  if (typeof input === "string") {
    return [input];
  }
  return responseInputItems(request)
    .filter((item) => item.role === "user")
    .map((item) => contentText(item.content));
}

function currentUserInput(request: ModelRequest | undefined): string {
  // Conversation metadata can follow the user message as a separate protected block.
  return userInputs(request).findLast((text) => !text.startsWith(RUNTIME_CONTEXT_HEADER)) ?? "";
}

function assertSteeringOrder(request: ModelRequest | undefined, marker: string) {
  const items = responseInputItems(request);
  const outputIndex = (id: string) =>
    items.findIndex(
      (item) => item.type === "function_call_output" && item.call_id === `call_steering_${id}`,
    );
  const gate = outputIndex("gate");
  const tail = outputIndex("tail");
  const steer = items.findIndex(
    (item) => item.role === "user" && contentText(item.content).includes(marker),
  );
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(tail).toBeGreaterThan(gate);
  expect(steer).toBeGreaterThan(tail);
  const gateOutput = contentText(items[gate]?.output);
  expect(gateOutput).toContain("steering gate completed");
  expect(contentText(items[tail]?.output)).toContain("Skipped to process an incoming message.");
  return gateOutput;
}

describe("Gateway steer FIFO", () => {
  it.each(["preflight", "execute"] as const)(
    "finishes the first tool and skips its sequential tail when steered during %s",
    async (mode) => {
      const preflight = mode === "preflight";
      const steerMarker = preflight ? "STEER_DURING_SEQUENTIAL_GATE" : "STEER_DURING_RUNNING_TOOL";
      const trace = preflight
        ? ["preflight-start", "preflight-end", "gate-executed"]
        : ["gate-execute-start", "gate-execute-end"];
      const fixture = await createGatewayFixture(
        preflight ? "steer-sequential-tail" : "steer-running-tool-tail",
        {
          withSteeringTools: true,
          steeringGateMode: mode,
          observeSteering: preflight ? steerMarker : undefined,
        },
      );
      const steeringTools = fixture.steeringTools;
      if (!steeringTools) {
        throw new Error("steering tool fixture was not configured");
      }
      const first = await sendHeldTurn(fixture, !preflight);

      try {
        fixture.modelServer.releaseFirst("sequential-tools");
        await vi.waitFor(async () => {
          expect(await readTrace(steeringTools.tracePath)).toEqual([trace[0]]);
          expect(fixture.modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);
        if (preflight) {
          await queueSteer(fixture, steerMarker);
        } else {
          const steerRunId = `run-${steerMarker.toLowerCase()}`;
          const steerResult = await directChat(fixture, steerMarker, steerRunId, "steer");
          expect(steerResult).toMatchObject({ runId: steerRunId, status: "started" });
          expect(fixture.modelServer.requests).toHaveLength(1);
          await setImmediate();
          expect(fixture.chatFinalRunIds).not.toContain(steerRunId);
        }
      } finally {
        await writeFile(steeringTools.releasePath, "release\n", "utf8");
      }

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      await waitForRunTerminal(fixture, first.runId);
      await vi.waitFor(
        async () => expect(await readTrace(steeringTools.tracePath)).toEqual(trace),
        WAIT_OPTS,
      );
      await setImmediate();

      const gateOutput = assertSteeringOrder(fixture.modelServer.requests[1], steerMarker);
      expect(await readTrace(steeringTools.tracePath)).toEqual(trace);
      if (!preflight) {
        expect(gateOutput).not.toContain("Skipped to process an incoming message.");
        expect(
          fixture.modelServer.requests
            .flatMap((request) => userInputs(request))
            .filter((input) => input.includes(steerMarker)),
        ).toHaveLength(1);
        expect(redactedFixtureLogs(fixture.instance)).not.toContain("active run changed");
      }
      expect(fixture.modelServer.requests).toHaveLength(2);
      expect(fixture.chatErrors).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["final", "tool"] as const)(
    "preserves queued steer FIFO across a %s response",
    async (responseKind) => {
      const tool = responseKind === "tool";
      const fixture = await createGatewayFixture(
        tool ? "steer-tool-control-point" : "steer-terminal-overtake",
        tool ? { observeSteering: "QUEUED_STEER_A" } : {},
      );
      const first = await sendHeldTurn(fixture);
      await queueSteer(fixture);
      if (!tool) {
        await queueOrdinaryFollowup(fixture);
      }
      const idleBaseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
        "diagnostics.stability",
        { type: "session.state", limit: 1 },
      );
      fixture.modelServer.releaseFirst(responseKind);
      const count = tool ? 2 : 3;
      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(count), WAIT_OPTS);
      const currentA = currentUserInput(fixture.modelServer.requests[1]);
      if (tool) {
        expect(currentA).toContain("QUEUED_STEER_A");
        expect(JSON.stringify(fixture.modelServer.requests[1]?.body)).toContain(
          "function_call_output",
        );
      }
      await waitForRunTerminal(fixture, first.runId);
      await waitForSessionIdle(fixture, idleBaseline.lastSeq ?? 0);
      if (tool) {
        expect(fixture.modelServer.requests).toHaveLength(2);
      } else {
        const currentB = currentUserInput(fixture.modelServer.requests[2]);
        expect(currentA).toContain("QUEUED_STEER_A");
        expect(currentA).not.toContain("ORDINARY_MESSAGE_B");
        expect(currentB).toContain("ORDINARY_MESSAGE_B");
        expect(currentB).not.toContain("QUEUED_STEER_A");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "withdraws a canceled CLI steer before the active run consumes it",
    async () => {
      const fixture = await createGatewayFixture("steer-cancellation", {
        cliMode: true,
        holdSecondResponse: true,
      });
      const { diagnosticsClient: client, modelServer, sessionKey } = fixture;
      const firstRunId = "initial-held-turn";
      const steerRunId = "canceled-steer";
      const steerMarker = "CANCELED_STEER_SENTINEL";
      const steerParams = {
        sessionKey,
        message: steerMarker,
        deliver: false,
        queueMode: "steer",
        idempotencyKey: steerRunId,
      };
      const historyWithoutSteer = async () => {
        const history = await client.request<{
          messages: Array<{ role: string; content?: unknown }>;
          sessionInfo: { hasActiveRun: boolean; status?: string };
        }>("chat.history", { sessionKey, limit: 100 });
        expect(
          history.messages.filter(
            (message) =>
              message.role === "user" && contentText(message.content).includes(steerMarker),
          ),
        ).toEqual([]);
        return history;
      };

      try {
        expect(
          await client.request("chat.send", {
            sessionKey,
            message: "INITIAL_HELD_TURN",
            deliver: false,
            idempotencyKey: firstRunId,
          }),
        ).toMatchObject({
          runId: firstRunId,
          status: "started",
        });
        await vi.waitFor(() => expect(modelServer.requests).toHaveLength(1), WAIT_OPTS);
        expect(await client.request("chat.send", steerParams)).toMatchObject({
          runId: steerRunId,
          status: "started",
        });
        await historyWithoutSteer();

        expect(await client.request("chat.abort", { sessionKey, runId: steerRunId })).toEqual({
          ok: true,
          aborted: true,
          runIds: [steerRunId],
        });
        expect((await historyWithoutSteer()).sessionInfo).toMatchObject({
          hasActiveRun: true,
          status: "running",
        });
        expect(modelServer.requests).toHaveLength(1);
        const idleBaseline = await client.request<{ lastSeq?: number }>("diagnostics.stability", {
          type: "session.state",
          limit: 1,
        });

        // No response bytes are released until the steer cancellation is acknowledged.
        modelServer.releaseFirst("tool");
        await vi.waitFor(() => expect(modelServer.requests).toHaveLength(2), WAIT_OPTS);
        const continuation = modelServer.requests[1];
        expect(userInputs(continuation).join("\n")).not.toContain(steerMarker);
        const statusResult = responseInputItems(continuation).find(
          (item) =>
            item.type === "function_call_output" && item.call_id === "call_steer_fifo_status",
        );
        expect(statusResult).toBeDefined();
        expect(contentText(statusResult?.output)).not.toContain(
          "Skipped to process an incoming message.",
        );
        expect((await historyWithoutSteer()).sessionInfo).toMatchObject({
          hasActiveRun: true,
          status: "running",
        });
        expect(
          fixture.events.filter(
            (event) =>
              event.runId === firstRunId &&
              event.stream === "lifecycle" &&
              (event.data?.phase === "end" || event.data?.phase === "error"),
          ),
        ).toEqual([]);

        expect(await client.request("chat.send", steerParams)).toMatchObject({
          runId: steerRunId,
          status: "timeout",
          summary: "aborted",
        });
        modelServer.releaseSecond();
        await waitForRunTerminal(fixture, firstRunId);
        await vi.waitFor(() => expect(fixture.chatFinalRunIds).toContain(firstRunId), WAIT_OPTS);
        await waitForSessionIdle(fixture, idleBaseline.lastSeq ?? 0);
        // Runtime terminal/idle events can precede reply accounting and dispatch cleanup.
        expect(
          await client.request("agent.wait", { runId: firstRunId, timeoutMs: WAIT_OPTS.timeout }),
        ).toMatchObject({ runId: firstRunId, status: "ok" });
        expect((await historyWithoutSteer()).sessionInfo.hasActiveRun).toBe(false);
        expect(modelServer.requests).toHaveLength(2);
        expect(fixture.chatFinalRunIds).not.toContain(steerRunId);
        expect(fixture.chatErrors).toEqual([]);
      } finally {
        modelServer.releaseFirst("tool");
        modelServer.releaseSecond();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "hands steered document attachments to the active run as extracted file context",
    async () => {
      const fixture = await createGatewayFixture("steer-document-context", {
        observeSteering: "QUEUED_STEER_DOCUMENT",
      });
      const first = await sendHeldTurn(fixture, true);

      // Real gateway protocol send with a file attachment while the initial
      // run is still live: admission must steer the active run instead of
      // dispatching a reply, and the extracted document context must reach
      // the prompt the run actually sends to the model.
      const steer = await fixture.diagnosticsClient.request<{ runId?: unknown; status?: unknown }>(
        "chat.send",
        {
          sessionKey: fixture.sessionKey,
          message: "QUEUED_STEER_DOCUMENT",
          deliver: false,
          queueMode: "steer",
          idempotencyKey: "run-steer-document",
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("steered document body", "utf8").toString("base64"),
              sizeBytes: "steered document body".length,
            },
          ],
        },
      );
      expect(steer).toMatchObject({ status: "started" });

      const admission = fixture.steeringAdmission;
      if (!admission) {
        throw new Error("steering admission observer was not configured");
      }
      // The upload ACK precedes document preparation and runtime steering admission.
      await vi.waitFor(
        async () =>
          expect(await readTrace(admission.receiptPath)).toContain("QUEUED_STEER_DOCUMENT"),
        WAIT_OPTS,
      );
      fixture.modelServer.releaseFirst("final");

      await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      const currentSteer = currentUserInput(fixture.modelServer.requests[1]);
      expect(currentSteer).toContain("QUEUED_STEER_DOCUMENT");
      // Extraction preserves the sender's filename, not the media-store basename.
      expect(currentSteer).toContain('<file name="notes.txt" mime="text/plain">');
      expect(currentSteer).toContain("steered document body");
      await waitForRunTerminal(fixture, first.runId);
    },
    TEST_TIMEOUT_MS,
  );
});
