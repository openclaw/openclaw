import { mkdtemp, rm } from "node:fs/promises";
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

type FirstResponseKind = "final" | "tool";
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

const TEST_TIMEOUT_MS = 180_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;
const STEERING_ADMISSION_PLUGIN_ID = "gateway-steering-admission";
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

async function startMockModelServer() {
  const requests: ModelRequest[] = [];
  const firstResponse = createDeferred();
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
          writeToolsResponse(res, "resp_steer_fifo_tool", [
            ["steer_fifo_status", "session_status"],
          ]);
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
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      firstResponse.resolve();
      await server.close();
    },
  };
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
  steeringAdmission?: SteeringAdmissionFixture;
}): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(
    `${params.modelServer.baseUrl}/v1`,
    "steer-fifo",
  );
  const modelConfig = restartModelConfig(provider, path.join(params.fixtureDir, "workspace"), {
    timeoutSeconds: undefined,
  });
  const fixturePlugins = params.steeringAdmission
    ? [{ id: STEERING_ADMISSION_PLUGIN_ID, dir: params.steeringAdmission.pluginDir }]
    : [];
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
    tools: { profile: "minimal" },
    messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
  };
}

async function connectDiagnosticsClient(instance: OpenClawTestInstance): Promise<GatewayClient> {
  const hello = createDeferred();
  const gatewayUrl = new URL(instance.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  const options: GatewayClientOptions = {
    url: instance.url,
    origin: gatewayUrl.origin,
    token: "steer-fifo-token",
    clientName: GATEWAY_CLIENT_NAMES.TUI,
    clientDisplayName: "steer-fifo-e2e-diagnostics",
    mode: GATEWAY_CLIENT_MODES.UI,
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
    observeSteering?: string;
  } = {},
) {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), `openclaw-${name}-`));
  cleanupDirs.push(fixtureDir);
  const steeringAdmission = options.observeSteering
    ? await writeSteeringAdmissionPlugin(fixtureDir, options.observeSteering)
    : undefined;
  const modelServer = await startMockModelServer();
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    gatewayToken: "steer-fifo-token",
    config: createConfig({ fixtureDir, modelServer, steeringAdmission }),
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
  client.onEvent = onEvent;
  client.start();
  await client.waitForReady();
  await client.subscribeSessionEvents();
  const diagnosticsClient = await connectDiagnosticsClient(instance);
  return {
    client,
    diagnosticsClient,
    instance,
    modelServer,
    events,
    chatErrors,
    chatFinalRunIds,
    sessionKey: `agent:main:${name}`,
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

async function sendHeldTurn(fixture: GatewayFixture) {
  const first = await sendChat(fixture, "INITIAL_HELD_TURN", "initial-held-turn");
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

describe("Gateway steer FIFO", () => {
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
});
