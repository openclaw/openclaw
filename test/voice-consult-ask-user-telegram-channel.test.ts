/**
 * Production-path proof: a Voice Call consult's ask_user question reaches the
 * requesting Telegram chat through Bot API, only that chat's owner can answer
 * it by plain text, and the same consult returns the model's follow-up to the
 * call.
 *
 * Lives under test/ so core gateway tests do not import the Telegram plugin.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionDispatchRefusedError } from "../src/agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../src/agents/harness/gateway-question.js";
import { withQuestionGateway } from "../src/agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../src/agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../src/auto-reply/reply/reply-run-registry.contracts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { withPluginRuntimeGatewayRequestScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { createRuntimeAgent } from "../src/plugins/runtime/runtime-agent.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { consultRealtimeVoiceAgent } from "../src/talk/agent-consult-runtime.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../src/utils/delivery-context.shared.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

vi.mock("../src/plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../src/tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const requesterSessionKey = "agent:main:telegram:direct:1";
const consultSessionKey = "agent:main:voice-consult";
const question = "Which appointment slot should I book?";
const chosenSlot = "Thursday 2 PM";
const followUp = "Booked the Thursday 2 PM slot.";

type CapturedRequest = { body: string; url: string };

type LoopbackServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

async function listenLoopback(
  handle: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = { body: Buffer.concat(chunks).toString("utf8"), url: request.url ?? "" };
      requests.push(entry);
      handle(entry, response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Telegram Bot API stand-in: records sends and resolves once the prompt arrives. */
async function startTelegramBotApi() {
  const prompt = createDeferredCore<CapturedRequest>();
  const server = await listenLoopback((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          message_id: server.requests.length,
          date: 1_700_000_000,
          chat: { id: 1, type: "private" },
          text: "ok",
        },
      }),
    );
    if (request.url.includes("sendMessage")) {
      prompt.resolve(request);
    }
  });
  return { ...server, prompt: prompt.promise };
}

/** Scripted OpenAI Responses model: first turn asks the user, the next turn answers the call. */
async function startScriptedModel() {
  const toolResults = createDeferredCore<string>();
  const askUserCall = {
    type: "function_call",
    id: "fc_voice_ask",
    call_id: "call_voice_ask",
    name: "ask_user",
    arguments: JSON.stringify({
      questions: [
        {
          id: "slot",
          header: "Slot",
          question,
          options: [{ label: "Tuesday 9 AM" }, { label: chosenSlot }],
        },
      ],
    }),
  };
  const server = await listenLoopback((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "voice-consult", object: "model" }] }));
      return;
    }
    if (request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    if (request.body.includes("function_call_output")) {
      toolResults.resolve(request.body);
      writeOpenAiResponsesText(response, {
        text: followUp,
        responseId: "response_voice_done",
        messageId: "message_voice_done",
      });
      return;
    }
    writeOpenAiResponsesSse(response, [
      {
        type: "response.created",
        response: { id: "response_voice_ask", status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...askUserCall, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: askUserCall.id,
        output_index: 0,
        delta: askUserCall.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item: askUserCall },
      {
        type: "response.completed",
        response: {
          id: "response_voice_ask",
          status: "completed",
          output: [askUserCall],
          usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
        },
      },
    ]);
  });
  return { ...server, toolResults: toolResults.promise };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

describe("voice consult ask_user Telegram round trip", () => {
  it(
    "asks the requesting chat, accepts only its owner's typed reply, and answers the call",
    { timeout: 90_000 },
    async () => {
      const { telegramPlugin } = await import("../extensions/telegram/api.js");
      const telegram = await startTelegramBotApi();
      const model = await startScriptedModel();
      await runQaGatewayFixture(
        () =>
          withOpenClawTestState(
            {
              label: "voice-consult-ask-user",
              env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
            },
            (state) =>
              withQuestionGateway(async (gateway) => {
                const registry = createTestRegistry([
                  { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
                ]);
                setActivePluginRegistry(registry);
                const provider = buildMockOpenAiResponsesProvider(
                  `${model.baseUrl}/v1`,
                  "voice-consult",
                );
                const cfg: OpenClawConfig = {
                  ...expectDefined(getRuntimeConfigSnapshot(), "isolated question gateway config"),
                  plugins: { enabled: false },
                  agents: {
                    entries: { main: { workspace: state.workspaceDir } },
                    defaults: {
                      model: { primary: provider.modelRef, fallbacks: [] },
                      models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
                      skills: [],
                      skipBootstrap: true,
                      heartbeat: { every: "0m" },
                    },
                  },
                  tools: { allow: ["ask_user"], codeMode: { enabled: false } },
                  models: {
                    mode: "replace",
                    providers: {
                      [provider.providerId]: {
                        ...provider.config,
                        request: { allowPrivateNetwork: true },
                      },
                    },
                  },
                  channels: {
                    telegram: {
                      botToken: "123456:voice-consult-ask-user",
                      apiRoot: telegram.baseUrl,
                    },
                  },
                };
                setRuntimeConfigSnapshot(cfg);
                await state.writeConfig(cfg);
                const agentRuntime = createRuntimeAgent();
                // The chat that placed the call: its session carries the Telegram delivery route.
                await replaceSessionEntry(
                  {
                    agentId: "main",
                    sessionKey: requesterSessionKey,
                    storePath: agentRuntime.session.resolveStorePath(cfg.session?.store, {
                      agentId: "main",
                    }),
                  },
                  {
                    sessionId: "requester-session",
                    updatedAt: Date.now(),
                    delivery: normalizeSessionDeliveryState({
                      context: { channel: "telegram", to: "1", accountId: "default" },
                    }),
                  },
                );
                const controller = new AbortController();
                const warn = vi.fn();
                // A consult that ends without asking must say what it saw instead.
                const describeEarlyFinish = (result: { text: string }) => {
                  const toolOutputs = model.requests.flatMap((entry) => {
                    try {
                      const input = (JSON.parse(entry.body) as { input?: unknown }).input;
                      return (Array.isArray(input) ? input : [])
                        .filter((item) => item?.type === "function_call_output")
                        .map((item) => String(item.output).slice(0, 600));
                    } catch {
                      return [];
                    }
                  });
                  return new Error(
                    `consult finished before the Telegram prompt was sent: ${JSON.stringify({
                      consultText: result.text,
                      modelRequests: model.requests.map((entry) => entry.url),
                      toolOutputs,
                      telegramRequests: telegram.requests.map((entry) =>
                        entry.url.split("/").pop(),
                      ),
                      gatewayMethods: gateway.requests.map((frame) => frame.method),
                      warnings: warn.mock.calls.map((call) => String(call[0])),
                    })}`,
                  );
                };
                // The Voice Call plugin runs its consult inside its own plugin runtime scope.
                const consult = withPluginRuntimeGatewayRequestScope(
                  {
                    pluginId: "voice-call",
                    pluginRegistry: registry,
                    isWebchatConnect: () => false,
                  },
                  () =>
                    consultRealtimeVoiceAgent({
                      cfg,
                      agentRuntime,
                      logger: { warn },
                      agentId: "main",
                      sessionKey: consultSessionKey,
                      spawnedBy: requesterSessionKey,
                      contextMode: "fork",
                      messageProvider: "voice",
                      lane: "voice",
                      runIdPrefix: "voice-consult-proof",
                      args: { question: "Book my dentist appointment this week." },
                      transcript: [],
                      surface: "a live phone call",
                      userLabel: "Caller",
                      senderIsOwner: true,
                      toolsAllow: ["ask_user"],
                      timeoutMs: 60_000,
                      abortSignal: controller.signal,
                    }),
                );
                void consult.catch(() => {});
                // Inbound chat replies carry trace authority the voice consult run never had.
                const answerFrom = (caller: Pick<ReplyToolAuthorityOverlay, "senderIsOwner">) =>
                  claimPendingAgentQuestionAnswerFromCaller({
                    sessionKey: requesterSessionKey,
                    text: chosenSlot,
                    caller: {
                      messageProvider: "telegram",
                      senderIsOwner: caller.senderIsOwner,
                      disableTools: false,
                      traceAuthorized: true,
                    },
                    persist: async () => {},
                    assertSourceCurrent: () => {},
                  });
                await runQaGatewayFixture(
                  async () => {
                    const prompt = await Promise.race([
                      telegram.prompt,
                      consult.then((result) => {
                        throw describeEarlyFinish(result);
                      }),
                    ]);
                    expect(prompt.body).toContain(question);
                    expect(prompt.body).toContain(chosenSlot);
                    expect(gateway.manager.list().map((entry) => entry.status)).toEqual([
                      "pending",
                    ]);

                    await expect(answerFrom({ senderIsOwner: false })).rejects.toBeInstanceOf(
                      QuestionDispatchRefusedError,
                    );
                    expect(gateway.manager.list().map((entry) => entry.status)).toEqual([
                      "pending",
                    ]);

                    await expect(answerFrom({ senderIsOwner: true })).resolves.toBe(true);
                    await expect(consult).resolves.toEqual({ text: followUp });
                    const toolResults = await model.toolResults;
                    expect(toolResults).toContain("answered");
                    expect(toolResults).toContain(chosenSlot);
                    expect(
                      telegram.requests.filter((entry) => entry.url.includes("sendMessage")),
                    ).toHaveLength(1);
                    expect(gateway.requests.map((frame) => frame.method)).toEqual(
                      expect.arrayContaining(["question.request", "question.resolve"]),
                    );
                  },
                  () => {
                    controller.abort();
                    for (const entry of gateway.manager.list()) {
                      gateway.manager.cancel(entry.id, "test-cleanup");
                    }
                  },
                  () => Promise.allSettled([consult]),
                );
              }),
          ),
        () => closeOpenClawStateDatabaseForTest(),
        () => model.close(),
        () => telegram.close(),
      );
    },
  );
});
