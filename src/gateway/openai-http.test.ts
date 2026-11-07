// OpenAI-compatible HTTP tests cover chat completions, streaming, tool calls,
// session context, auth scopes, and provider error mapping.
import http from "node:http";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { TRUNCATED_REPLY_NOTICE_TEXT } from "../agents/embedded-agent-runner/run/incomplete-turn-resolution.js";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "../agents/embedded-agent-subscribe.js";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import {
  expectDeclaredHttpOwnerIdentity,
  expectHttpForeignSessionAuthority,
  expectSharedSecretHttpOwnerIdentity,
} from "./http-authority.test-support.js";
import {
  registerOpenAiHttpUploadTests,
  runOpenAiHttpImageInputCases,
} from "./http-input-media.test-support.js";
import {
  assistantSnapshotCases,
  streamingFailureCases,
  captureStreamingTerminals,
  emitResolvedStreamingFailure,
  incompatibleReplacementCases,
  compatibleReplacementCases,
  bufferedReplacementCases,
  emitIncompatibleAssistantReplacement,
  emitCompatibleAssistantReplacement,
  emitBufferedAssistantReplacement,
  emitEmbeddedLateCommentary,
  createOpenAiHttpTestClient,
  parseSseDataLines,
  readRawChatCompletionStream,
} from "./http-stream.test-support.js";
import { registerOpenAiHttpSamplingTests } from "./openai-http.sampling.test-support.js";
import { browserProxyAuth } from "./server.auth.test-helpers.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import { writeGatewayConfig } from "./test-helpers.config-runtime.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
  testState,
  withGatewayServer,
} from "./test-helpers.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startGatewayServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
});

async function startSharedSecretServer(port: TestPortClaim, mode: "token" | "password") {
  return await startClaimedGateway(port, () =>
    startGatewayServer(port.port, {
      host: "127.0.0.1",
      auth:
        mode === "token"
          ? { mode: "token", token: "secret" }
          : { mode: "password", password: "secret" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    }),
  );
}

function chatRequest(overrides: Record<string, unknown> = {}, content = "hi") {
  return { model: "openclaw", messages: [{ role: "user", content }], ...overrides };
}

type AgentResult = {
  payloads: Array<{ text?: string }>;
  meta?: {
    stopReason?: string;
    pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
    agentMeta?: { usage?: Record<string, number>; lastCallUsage?: Record<string, number> };
  };
};

function mockAgentResult(result: AgentResult) {
  agentCommandMock.mockClear();
  agentCommandMock.mockResolvedValueOnce(result as never);
}

function mockAgentOnce(payloads: AgentResult["payloads"] = [{ text: "hello" }]) {
  mockAgentResult({ payloads });
}

function toolResult<T extends AgentResult["payloads"]>(
  payloads: T,
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>,
  agentMeta?: NonNullable<AgentResult["meta"]>["agentMeta"],
) {
  return {
    payloads,
    meta: { stopReason: "tool_calls", pendingToolCalls, ...(agentMeta && { agentMeta }) },
  };
}

function weatherCall() {
  return { id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' };
}

function usageResult(
  text: string,
  agentMeta: NonNullable<AgentResult["meta"]>["agentMeta"],
): AgentResult {
  return { payloads: [{ text }], meta: { agentMeta } };
}

type ErrorResponse = { error?: { type?: string; message?: string } };
type StreamChunk = OpenAI.ChatCompletionChunk & { error?: ErrorResponse["error"] };

function parseChunks(data: string[]): StreamChunk[] {
  return data.filter((line) => line !== "[DONE]").map((line) => JSON.parse(line) as StreamChunk);
}

function streamChoices(chunks: StreamChunk[]) {
  return chunks.flatMap((chunk) => chunk.choices ?? []);
}

function streamContent(chunks: StreamChunk[]) {
  return streamChoices(chunks)
    .map((choice) => choice.delta.content ?? "")
    .join("");
}

async function readSdkStream(stream: AsyncIterable<OpenAI.ChatCompletionChunk>) {
  const choices: OpenAI.ChatCompletionChunk["choices"] = [];
  for await (const chunk of stream) {
    choices.push(...chunk.choices);
  }
  return {
    content: choices.map((choice) => choice.delta.content ?? "").join(""),
    finishReasons: choices.map((choice) => choice.finish_reason),
  };
}

function mockAgentRun(run: (runId: string) => unknown, requireRunId = false) {
  agentCommandMock.mockClear();
  agentCommandMock.mockImplementationOnce(((opts: unknown) => {
    const runId = (opts as { runId?: string }).runId ?? "";
    if (requireRunId && !runId) {
      throw new Error("expected a streaming chat-completion run ID");
    }
    return run(runId);
  }) as never);
}

async function expectRejectedChat(
  body: unknown,
  message: string | RegExp,
  {
    headers,
    status = 400,
    type = "invalid_request_error",
    contains = false,
  }: {
    headers?: Record<string, string>;
    status?: number;
    type?: string;
    contains?: boolean;
  } = {},
) {
  agentCommandMock.mockClear();
  const res = await postChatCompletions(enabledPort, body, headers);
  expect(res.status).toBe(status);
  const json = (await res.json()) as ErrorResponse;
  expect(json.error?.type).toBe(type);
  if (contains) {
    expect(json.error?.message).toContain(message);
  } else if (message instanceof RegExp) {
    expect(json.error?.message).toMatch(message);
  } else {
    expect(json.error?.message).toBe(message);
  }
  expect(agentCommandMock).toHaveBeenCalledTimes(0);
}

function functionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown> = { type: "object", properties: {} },
  strict?: boolean,
): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters, ...(strict === undefined ? {} : { strict }) },
  };
}

async function postChatCompletions(
  port: number,
  body: unknown = chatRequest(),
  headers?: Record<string, string>,
) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function postRawChatCompletions(port: number, body: string) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
    },
    body,
  });
}

async function dispatchChat(
  body: unknown = chatRequest(),
  headers?: Record<string, string>,
  payloads: AgentResult["payloads"] = [{ text: "hello" }],
) {
  mockAgentOnce(payloads);
  const response = await postChatCompletions(enabledPort, body, headers);
  expect(response.status).toBe(200);
  await response.text();
}

type FirstAgentCommandOptions = Pick<
  AgentCommandOpts,
  | "clientTools"
  | "extraSystemPrompt"
  | "images"
  | "message"
  | "messageChannel"
  | "model"
  | "senderIsOwner"
  | "sessionKey"
  | "streamParams"
> & { onAdmittedRunContext?: (context: object) => void | Promise<void> };

function firstAgentCommandOptions() {
  return agentCommandMock.mock.calls.at(0)?.[0] as FirstAgentCommandOptions | undefined;
}

describe("OpenAI-compatible HTTP API (e2e)", () => {
  beforeAll(async () => {
    const started = await startGatewayServerWithRetries({
      port: await getGatewayTestPort(),
      opts: {
        host: "127.0.0.1",
        auth: { mode: "none" },
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: true,
      },
    });
    enabledPort = started.port;
    enabledServer = started.server;
  });

  afterAll(async () => {
    await enabledServer?.close({ reason: "openai http enabled suite done" });
  });

  registerOpenAiHttpUploadTests({
    getPort: () => enabledPort,
    postChatCompletions,
    firstAgentCommandOptions,
    agentCommandMock,
  });

  it.each([
    { stream: false, includeUsage: false },
    { stream: true, includeUsage: false },
    { stream: true, includeUsage: true },
  ])(
    "preserves the output-budget finish reason (stream=$stream, usage=$includeUsage)",
    async ({ stream, includeUsage }) => {
      const partialText = "Here is the first half of the answer";
      // The terminal-resolution suite owns producing this result; this suite owns HTTP delivery.
      const result = {
        payloads: [{ text: partialText }, { text: TRUNCATED_REPLY_NOTICE_TEXT }],
        meta: { stopReason: "length" },
      };
      const continueAgent = createDeferred();
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        if (stream) {
          const runId = (opts as { runId: string }).runId;
          emitAgentEvent({ runId, stream: "assistant", data: { delta: partialText } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          await continueAgent.promise;
        }
        return recordAgentRunTerminalOutcome(result, "completed");
      }) as never);

      try {
        const response = await postChatCompletions(
          enabledPort,
          chatRequest(
            { stream, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) },
            "Explain the result.",
          ),
        );
        expect(response.status).toBe(200);
        if (!stream) {
          const completion = (await response.json()) as OpenAI.ChatCompletion;
          expect(completion.choices[0]?.message.content).toContain(partialText);
          expect(completion.choices[0]?.finish_reason).toBe("length");
          return;
        }

        if (!response.body) {
          throw new Error("expected a streaming response body");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let wire = "";
        while (!wire.includes(partialText)) {
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          wire += decoder.decode(value, { stream: true });
        }
        expect(wire).not.toContain("[DONE]");
        continueAgent.resolve();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            wire += decoder.decode();
            break;
          }
          wire += decoder.decode(value, { stream: true });
        }
        const data = parseSseDataLines(wire);
        const chunks = parseChunks(data);
        const choices = chunks.flatMap((chunk) => chunk.choices);
        expect(choices.map((choice) => choice.delta.content ?? "").join("")).toContain(partialText);
        expect(choices.map((choice) => choice.finish_reason).filter(Boolean)).toEqual(["length"]);
        expect(chunks.filter((chunk) => chunk.usage)).toHaveLength(includeUsage ? 1 : 0);
        expect(data.filter((entry) => entry === "[DONE]")).toHaveLength(1);
        expect(data.at(-1)).toBe("[DONE]");
      } finally {
        continueAgent.resolve();
      }
    },
  );

  it.each(
    (
      [
        { name: "empty string", result: { role: "tool", tool_call_id: "call_1", content: "" } },
        { name: "whitespace", result: { role: "tool", tool_call_id: "call_1", content: " \n " } },
        { name: "empty array", result: { role: "tool", tool_call_id: "call_1", content: [] } },
        {
          name: "empty text part",
          result: { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "" }] },
        },
        { name: "legacy empty string", result: { role: "function", name: "lookup", content: "" } },
        { name: "legacy null", result: { role: "function", name: "lookup", content: null } },
      ] satisfies Array<{
        name: string;
        result: OpenAI.ChatCompletionToolMessageParam | OpenAI.ChatCompletionFunctionMessageParam;
      }>
    ).map(({ name, result }, index) => ({ name, result, stream: index === 0 })),
  )("continues a client tool result with $name (stream=$stream)", async ({ result, stream }) => {
    mockAgentResult({ payloads: [{ text: "Lookup completed." }] });
    const client = createOpenAiHttpTestClient(enabledPort);
    const request = {
      model: "openclaw",
      messages: [
        { role: "user", content: "Check the account." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        result,
      ] satisfies OpenAI.ChatCompletionMessageParam[],
    };
    const response = stream
      ? await client.chat.completions.stream(request).finalChatCompletion()
      : await client.chat.completions.create(request);
    expect(response.choices[0]?.message.content).toBe("Lookup completed.");
    expect(response.choices[0]?.finish_reason).toBe("stop");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const message = firstAgentCommandOptions()?.message;
    expect(message).toContain("tool_call id=call_1 name=lookup arguments={}");
    expect(message?.split(CURRENT_MESSAGE_MARKER)[1]).toBe(
      `\nTool:${result.role === "function" ? result.name : result.tool_call_id}: `,
    );
  });

  it.each([false, true])(
    "preserves each parallel client tool result (emptyFirst=%s)",
    async (emptyFirst) => {
      mockAgentResult({
        payloads: [{ text: "Both lookups completed." }],
      });
      const results: OpenAI.ChatCompletionToolMessageParam[] = [
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "0" },
      ];
      const response = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
        model: "openclaw",
        messages: [
          { role: "user", content: "Compare the accounts." },
          {
            role: "assistant",
            content: null,
            tool_calls: ["call_1", "call_2"].map((id) => ({
              id,
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            })),
          },
          ...(emptyFirst ? results : results.toReversed()),
        ],
      });
      expect(response.choices[0]?.message.content).toBe("Both lookups completed.");
      const message = firstAgentCommandOptions()?.message;
      expect(message).toContain("Tool:call_1: ");
      expect(message).toContain("Tool:call_2: 0");
      expect(message?.split(CURRENT_MESSAGE_MARKER)[1]).toBe(
        emptyFirst ? "\nTool:call_2: 0" : "\nTool:call_1: ",
      );
    },
  );

  it.each([
    { role: "tool", tool_call_id: "call_1" },
    { role: "tool", tool_call_id: "call_1", content: 0 },
    { role: "tool", tool_call_id: "call_1", content: [null] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: 0 }] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "" }, {}] },
    { role: "tool", tool_call_id: " ", content: "" },
    { role: "function", name: "lookup" },
    { role: "function", name: "lookup", content: [] },
    { role: "function", content: null },
    { role: "user", content: "" },
  ])(
    "does not invent a client tool result for malformed or missing content: %j",
    async (message) => {
      agentCommandMock.mockClear();
      const response = await postChatCompletions(enabledPort, chatRequest({ messages: [message] }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("returns a typed selection error unless an ownerless fleet request selects an agent", async () => {
    try {
      testState.agentsConfig = {
        ownership: "explicit",
        entries: { main: {}, beta: {} },
      };
      resetConfigRuntimeState();
      agentCommandMock.mockClear();

      const missing = await postChatCompletions(enabledPort);
      expect(missing.status).toBe(400);
      const missingJson = (await missing.json()) as ErrorResponse;
      expect(missingJson.error?.type).toBe("invalid_request_error");
      expect(missingJson.error?.message).toContain("has no explicit owner");
      expect(agentCommandMock).not.toHaveBeenCalled();

      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
      const selected = await postChatCompletions(
        enabledPort,
        { model: "openclaw/default", messages: [{ role: "user", content: "hi" }] },
        { "x-openclaw-agent-id": "main" },
      );
      expect(selected.status).toBe(200);
      expect(firstAgentCommandOptions()?.sessionKey ?? "").toMatch(/^agent:main:/);
      await selected.text();
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("handles request validation and routing", async () => {
    const port = enabledPort;
    const expectAgentSessionKeyMatch = async (
      body: unknown,
      matcher: RegExp,
      headers?: Record<string, string>,
    ) => {
      await dispatchChat(body, headers);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(firstAgentCommandOptions()?.sessionKey ?? "").toMatch(matcher);
    };
    const expectMessageContext = (
      message: string,
      expected: { history: string[]; current: string[] },
    ) => {
      expect(message).toContain(HISTORY_CONTEXT_MARKER);
      for (const line of expected.history) {
        expect(message).toContain(line);
      }
      expect(message).toContain(CURRENT_MESSAGE_MARKER);
      for (const line of expected.current) {
        expect(message).toContain(line);
      }
    };
    const getFirstAgentMessage = () => firstAgentCommandOptions()?.message ?? "";
    const checkConversation = async (
      messages: unknown[],
      expected: { history: string[]; current: string[] },
      payloads: AgentResult["payloads"],
    ) => {
      await dispatchChat(chatRequest({ messages }), undefined, payloads);
      const message = getFirstAgentMessage();
      expectMessageContext(message, expected);
      return message;
    };
    const expectInvalidRequestNoDispatch = async (messages: unknown[]) => {
      agentCommandMock.mockClear();
      const res = await postChatCompletions(port, chatRequest({ messages }));
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.type).toBe("invalid_request_error");
      expect(error?.message).toBe("Invalid image_url content in `messages`.");
      expect(agentCommandMock).toHaveBeenCalledTimes(0);
    };
    const postSyncUserMessage = async (message: string) => {
      const res = await postChatCompletions(port, chatRequest({ stream: false }, message));
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    try {
      testState.agentsConfig = { entries: { main: {} } };
      resetConfigRuntimeState();

      {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "GET",
          headers: { authorization: "Bearer secret" },
        });
        expect(res.status).toBe(405);
        await res.text();
      }

      {
        mockAgentOnce();
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openclaw-agent-id": "main",
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        expect(firstAgentCommandOptions()?.messageChannel).toBe("webchat");
        await res.text();
      }

      testState.agentsConfig = {
        ownership: "explicit",
        entries: { main: {}, beta: {} },
      };
      resetConfigRuntimeState();
      await expectAgentSessionKeyMatch(chatRequest(), /^agent:beta:/, {
        "x-openclaw-agent-id": "beta",
      });
      await expectAgentSessionKeyMatch(chatRequest({ model: "openclaw/beta" }), /^agent:beta:/);

      testState.agentsConfig = { entries: { main: {} } };
      resetConfigRuntimeState();

      await expectAgentSessionKeyMatch(chatRequest({ model: "openclaw/default" }), /^agent:main:/, {
        "x-openclaw-agent-id": "main",
      });

      await expectRejectedChat(chatRequest(), "Unknown agent 'missing-agent'.", {
        headers: {
          "x-openclaw-agent-id": "missing-agent",
        },
      });

      await expectRejectedChat(
        chatRequest({ model: "openclaw/missing-agent" }),
        "Unknown agent 'missing-agent'.",
      );

      await expectRejectedChat(
        chatRequest(),
        "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        {
          headers: {
            "x-openclaw-session-key": "agent:main:harness:codex:supervision:spoofed-native-thread",
          },
        },
      );

      {
        testState.agentsConfig = {
          ownership: "explicit",
          entries: { main: {}, beta: {} },
        };
        resetConfigRuntimeState();
        mockAgentOnce();
        const res = await postChatCompletions(port, chatRequest(), {
          "x-openclaw-agent-id": "beta",
          "x-openclaw-session-key": "agent:beta:openai:custom",
        });
        expect(res.status).toBe(200);

        expect(firstAgentCommandOptions()?.sessionKey).toBe("agent:beta:openai:custom");
        await res.text();
        testState.agentsConfig = { entries: { main: {} } };
        resetConfigRuntimeState();
      }

      await expectRejectedChat(
        chatRequest(),
        "`x-openclaw-session-key` cannot use reserved internal session namespaces.",
        {
          headers: {
            "x-openclaw-session-key": "agent:main:subagent:spoofed",
          },
        },
      );

      await dispatchChat(chatRequest({ user: "alice" }));

      expect(firstAgentCommandOptions()?.sessionKey ?? "").toContain("openai-user:alice");

      await dispatchChat(chatRequest(), {
        "x-openclaw-message-channel": "custom-client-channel",
      });
      expect(firstAgentCommandOptions()?.messageChannel).toBe("custom-client-channel");

      await dispatchChat(chatRequest(), {
        "x-openclaw-model": "openai/gpt-5.4",
        "x-openclaw-scopes": "operator.admin, operator.write",
      });
      expect(firstAgentCommandOptions()?.model).toBe("openai/gpt-5.4");

      {
        await writeGatewayConfig({
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
              models: {
                "openai/gpt-5.4": {},
              },
            },
          },
        });
        mockAgentOnce();
        const res = await postChatCompletions(port, chatRequest(), {
          "x-openclaw-model": "gpt-5.4",
          "x-openclaw-scopes": "operator.admin, operator.write",
        });
        expect(res.status).toBe(200);
        expect(firstAgentCommandOptions()?.model).toBe("gpt-5.4");
        await res.text();
        await writeGatewayConfig({});
      }

      await expectRejectedChat(
        chatRequest({ model: "openai/" }),
        "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
      );

      await expectRejectedChat(chatRequest(), "missing scope: operator.admin", {
        headers: {
          "x-openclaw-model": "openai/gpt-5.4",
        },
        status: 403,
        type: "forbidden",
      });

      await expectRejectedChat(chatRequest(), "Invalid `x-openclaw-model`.", {
        headers: {
          "x-openclaw-model": "openai/",
          "x-openclaw-scopes": "operator.admin, operator.write",
        },
      });

      await dispatchChat(
        chatRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "input_text", text: "world" },
              ],
            },
          ],
        }),
      );

      expect(firstAgentCommandOptions()?.message).toBe("hello\nworld");

      await runOpenAiHttpImageInputCases({
        port,
        postChatCompletions,
        mockAgentOnce,
        getFirstAgentCall: firstAgentCommandOptions,
        getFirstAgentMessage,
        expectInvalidRequestNoDispatch,
      });

      {
        const largeMessage = "x".repeat(1_200_000);
        mockAgentOnce([{ text: "accepted" }]);
        const res = await postChatCompletions(port, chatRequest({}, largeMessage));
        expect(res.status).toBe(200);
        await res.text();
      }

      await expectInvalidRequestNoDispatch([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:application/pdf;base64,QUJDRA==" },
            },
          ],
        },
      ]);

      {
        const manyImageParts = Array.from({ length: 9 }).map(() => ({
          type: "image_url",
          image_url: { url: "data:image/png;base64,QUJDRA==" },
        }));
        await expectInvalidRequestNoDispatch([
          {
            role: "user",
            content: manyImageParts,
          },
        ]);
      }

      await checkConversation(
        [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello, who are you?" },
          { role: "assistant", content: "I am Claude." },
          { role: "user", content: "What did I just ask you?" },
        ],
        {
          history: ["User: Hello, who are you?", "Assistant: I am Claude."],
          current: ["User: What did I just ask you?"],
        },
        [{ text: "I am Claude" }],
      );

      {
        await dispatchChat(
          chatRequest({
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: "Hello" },
            ],
          }),
        );

        const message = getFirstAgentMessage();
        expect(message).not.toContain(HISTORY_CONTEXT_MARKER);
        expect(message).not.toContain(CURRENT_MESSAGE_MARKER);
        expect(message).toBe("Hello");
      }

      {
        await dispatchChat(
          chatRequest({
            messages: [
              { role: "developer", content: "You are a helpful assistant." },
              { role: "user", content: "Hello" },
            ],
          }),
        );

        const extraSystemPrompt = firstAgentCommandOptions()?.extraSystemPrompt ?? "";
        expect(extraSystemPrompt).toBe("You are a helpful assistant.");
      }

      await checkConversation(
        [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "What's the weather?" },
          { role: "assistant", content: "Checking the weather." },
          { role: "tool", content: "Sunny, 70F." },
        ],
        {
          history: ["User: What's the weather?", "Assistant: Checking the weather."],
          current: ["Tool: Sunny, 70F."],
        },
        [{ text: "ok" }],
      );

      {
        const message = await checkConversation(
          [
            {
              role: "user",
              content: [
                { type: "text", text: "look at this" },
                { type: "image_url", image_url: { url: "https://example.com/image.png" } },
              ],
            },
            { role: "assistant", content: "Checking the image." },
            { role: "tool", content: "Vision tool says it is blue." },
          ],
          {
            history: ["User: look at this", "Assistant: Checking the image."],
            current: ["Tool: Vision tool says it is blue."],
          },
          [{ text: "tool follow-up ok" }],
        );

        const firstCall = firstAgentCommandOptions();
        expect(firstCall?.images).toBeUndefined();

        expect(message).not.toContain("User sent image(s) with no text.");
      }

      {
        await dispatchChat(
          chatRequest({
            tool_choice: "none",
            tools: [functionTool("get_time", "Get current time")],
          }),
          undefined,
          [{ text: "tool choice none" }],
        );
        const firstCall = firstAgentCommandOptions();
        expect(firstCall?.clientTools).toBeUndefined();
      }

      {
        await dispatchChat(
          chatRequest({
            tool_choice: "auto",
            tools: [functionTool("get_time", "Get current time", undefined, true)],
          }),
          undefined,
          [{ text: "tool choice auto" }],
        );
        const firstCall = firstAgentCommandOptions();
        const clientTools = firstCall?.clientTools ?? [];
        expect(clientTools).toHaveLength(1);
        expect(clientTools[0]?.type).toBe("function");
        expect(clientTools[0]?.function?.name).toBe("get_time");
        expect(clientTools[0]?.function?.strict).toBe(true);
        expect(firstCall).not.toHaveProperty("toolsAllow");
      }

      for (const [tool_choice, prompt] of [
        [
          { type: "function", function: { name: "get_weather" } },
          "You must call the get_weather tool",
        ],
        ["required", "You must call one of the available tools"],
      ] as const) {
        mockAgentResult(toolResult([{ text: "tool choice" }], [weatherCall()]));
        const res = await postChatCompletions(
          port,
          chatRequest({
            tool_choice,
            tools: [
              ...(tool_choice === "required" ? [] : [functionTool("get_time", "Get current time")]),
              functionTool("get_weather", "Get current weather", {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              }),
            ],
          }),
        );
        expect(res.status).toBe(200);
        const firstCall = firstAgentCommandOptions();
        const clientTools = firstCall?.clientTools ?? [];
        expect(clientTools).toHaveLength(1);
        expect(clientTools[0]?.function?.name).toBe("get_weather");
        expect(firstCall?.extraSystemPrompt ?? "").toContain(prompt);
        const json = (await res.json()) as OpenAI.ChatCompletion;
        expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
      }

      {
        mockAgentOnce([{ text: "plain text despite required" }]);
        const res = await postChatCompletions(
          port,
          chatRequest({
            tool_choice: "required",
            tools: [functionTool("get_weather", "Get current weather")],
          }),
        );
        expect(res.status).toBe(502);
        const json = (await res.json()) as ErrorResponse;
        expect(json.error?.type).toBe("api_error");
        expect(json.error?.message ?? "").toContain("tool_choice=required was not satisfied");
      }

      {
        mockAgentResult(
          toolResult(
            [{ text: "Calling a different tool." }],
            [{ id: "call_1", name: "get_time", arguments: "{}" }],
          ),
        );
        const res = await postChatCompletions(
          port,
          chatRequest({
            tool_choice: { type: "function", function: { name: "get_weather" } },
            tools: [
              functionTool("get_weather", "Get current weather"),
              functionTool("get_time", "Get current time"),
            ],
          }),
        );
        expect(res.status).toBe(502);
        const json = (await res.json()) as ErrorResponse;
        expect(json.error?.type).toBe("api_error");
        expect(json.error?.message ?? "").toContain("tool_choice required a get_weather tool call");
      }

      for (const [body, message] of [
        [{ tool_choice: "required" }, "no tools were provided"],
        [
          {
            tool_choice: { type: "function", function: { name: "missing_tool" } },
            tools: [functionTool("get_time", "Get current time")],
          },
          "unknown tool",
        ],
        [
          {
            tool_choice: {
              type: "allowed_tools",
              tools: [{ type: "function", function: { name: "x" } }],
            },
            tools: [functionTool("x", "x")],
          },
          "allowed_tools",
        ],
        [
          {
            tools: [
              {
                type: "function",
                name: "invalid_flat_shape",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          "tool.function is required",
        ],
      ] as const) {
        await expectRejectedChat(chatRequest(body), message, { contains: true });
      }

      await checkConversation(
        [
          { role: "user", content: "What's the weather?" },
          { role: "assistant", content: "Checking the weather." },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [{ type: "text", text: "Sunny, 70F." }],
          },
        ],
        {
          history: ["User: What's the weather?", "Assistant: Checking the weather."],
          current: ["Tool:call_1: Sunny, 70F."],
        },
        [{ text: "ok" }],
      );

      await checkConversation(
        [
          { role: "user", content: "What's the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Taipei"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [{ type: "text", text: "Sunny, 70F." }],
          },
        ],
        {
          history: [
            "User: What's the weather?",
            'Assistant: tool_call id=call_1 name=get_weather arguments={"city":"Taipei"}',
          ],
          current: ["Tool:call_1: Sunny, 70F."],
        },
        [{ text: "ok" }],
      );

      {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(new Error("client tool name conflict: exec"));
        const res = await postChatCompletions(
          port,
          chatRequest({
            stream: false,
            tools: [functionTool("exec", "conflicts with a built-in tool")],
          }),
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as ErrorResponse;
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("invalid tool configuration");
      }

      {
        mockAgentResult(
          toolResult(
            [{ text: "Let me check that." }],
            [
              weatherCall(),
              {
                id: "call_2",
                name: "get_time",
                arguments: "{}",
              },
            ],
            {
              usage: {
                input: 10,
                output: 5,
                total: 15,
              },
            },
          ),
        );
        const res = await postChatCompletions(
          port,
          chatRequest({
            stream: false,
            tool_choice: "auto",
            tools: [
              functionTool("get_weather", "Get weather", {
                type: "object",
                properties: { city: { type: "string" } },
              }),
              functionTool("get_time", "Get time"),
            ],
          }),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as OpenAI.ChatCompletion;
        const choice = json.choices?.[0];
        expect(choice?.finish_reason).toBe("tool_calls");
        expect(choice?.message?.role).toBe("assistant");
        expect(choice?.message?.content).toBe("Let me check that.");
        expect(choice?.message?.tool_calls).toEqual([
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ]);
      }

      {
        mockAgentResult(toolResult([], [weatherCall()]));
        const res = await postChatCompletions(
          port,
          chatRequest({
            stream: false,
            tool_choice: "auto",
            tools: [
              functionTool("get_weather", "Get weather", {
                type: "object",
                properties: { city: { type: "string" } },
              }),
            ],
          }),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as OpenAI.ChatCompletion;
        const choice = json.choices?.[0];
        expect(choice?.finish_reason).toBe("tool_calls");
        expect(choice?.message?.content).toBe("");
        expect(choice?.message?.tool_calls).toHaveLength(1);
      }

      {
        mockAgentOnce();
        const json = await postSyncUserMessage("hi");
        expect(json.object).toBe("chat.completion");
        expect(Array.isArray(json.choices)).toBe(true);
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("hello");
      }

      {
        mockAgentRun(async (runId) => {
          const { session, emit } = createStubSessionHarness();
          subscribeEmbeddedAgentSession({ session, runId });
          emit({ type: "message_start", message: { role: "assistant" } });
          for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
            emitAssistantTextDelta({ emit, delta });
          }
          return { payloads: [{ text: "Title\nLine one\nLine two" }] };
        });

        const splitFinalRes = await postChatCompletions(port, chatRequest({ stream: true }));
        expect(splitFinalRes.status).toBe(200);
        const splitFinalText = await splitFinalRes.text();
        const splitFinalData = parseSseDataLines(splitFinalText);
        const splitFinalChunks = parseChunks(splitFinalData);
        const splitFinalContent = streamContent(splitFinalChunks);
        expect(splitFinalContent).toBe("Title\nLine one\nLine two");
      }

      for (const [agentMeta, expected] of [
        [
          { usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 } },
          {
            prompt_tokens: 30,
            completion_tokens: 5,
            total_tokens: 35,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        ],
        [
          { lastCallUsage: { input: 80, output: 20, total: 100 } },
          { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        ],
        [
          {
            usage: {
              input: Infinity,
              output: Number.NaN,
              cacheRead: 2,
              cacheWrite: Infinity,
              total: Number.NaN,
            },
          },
          {
            prompt_tokens: 2,
            completion_tokens: 0,
            total_tokens: 2,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        ],
        [
          { usage: { input: Infinity, output: Number.NaN, total: 123 } },
          { prompt_tokens: 0, completion_tokens: 0, total_tokens: 123 },
        ],
      ] satisfies Array<[NonNullable<AgentResult["meta"]>["agentMeta"], OpenAI.CompletionUsage]>) {
        mockAgentResult(usageResult("usage", agentMeta));
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual(expected);
      }

      {
        mockAgentResult({ payloads: [{ text: "" }] });
        const json = await postSyncUserMessage("hi");
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.content).toBe("No response from OpenClaw.");
      }

      {
        const res = await postChatCompletions(
          port,
          chatRequest({ messages: [{ role: "system", content: "yo" }] }),
        );
        expect(res.status).toBe(400);
        const missingUserJson = (await res.json()) as Record<string, unknown>;
        expect((missingUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
          "invalid_request_error",
        );
      }
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("validates and forwards max_completion_tokens and max_tokens into streamParams", async () => {
    const port = enabledPort;
    const getRecordedAgentMaxTokens = () => firstAgentCommandOptions()?.streamParams?.maxTokens;

    const validCases: Array<[Record<string, unknown>, number | undefined]> = [
      [{ max_completion_tokens: 256 }, 256],
      [{ max_tokens: 128 }, 128],
      [{ max_completion_tokens: 64, max_tokens: 999 }, 64],
      [{ max_completion_tokens: null, max_tokens: 32 }, 32],
      [{ max_completion_tokens: 16, max_tokens: null }, 16],
      [{ max_completion_tokens: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER],
      [{}, undefined],
    ];

    for (const [body, expected] of validCases) {
      await dispatchChat(chatRequest(body));
      expect(getRecordedAgentMaxTokens(), JSON.stringify(body)).toBe(expected);
    }

    mockAgentOnce();
    const client = createOpenAiHttpTestClient(port);
    await client.chat.completions.create({
      model: "openclaw",
      max_completion_tokens: null,
      max_tokens: null,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(getRecordedAgentMaxTokens(), "SDK null fields").toBeUndefined();
  });

  it("rejects malformed token caps before agent dispatch", async () => {
    const port = enabledPort;
    for (const field of ["max_completion_tokens", "max_tokens"] as const) {
      for (const value of ["32", {}, [32], 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectRejectedChat(chatRequest({ [field]: value }), field, { contains: true });
      }

      agentCommandMock.mockClear();
      const res = await postRawChatCompletions(
        port,
        `{"model":"openclaw","messages":[{"role":"user","content":"hi"}],"${field}":1e309}`,
      );
      expect(res.status, `${field}: non-finite raw number`).toBe(400);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error?.type).toBe("invalid_request_error");
      expect(json.error?.message).toContain(field);
      expect(agentCommandMock, `${field}: non-finite raw number`).toHaveBeenCalledTimes(0);
    }

    for (const [body, field] of [
      [{ max_completion_tokens: "64", max_tokens: 32 }, "max_completion_tokens"],
      [{ max_completion_tokens: 64, max_tokens: "32" }, "max_tokens"],
    ] as const) {
      await expectRejectedChat(chatRequest(body), field, { contains: true });
    }
  });

  registerOpenAiHttpSamplingTests({
    getPort: () => enabledPort,
    postChatCompletions,
    postRawChatCompletions,
    firstAgentCommandOptions,
    agentCommandMock,
  });

  it("forwards inbound stop into streamParams", async () => {
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    await dispatchChat(chatRequest({ stop: "\n\n" }));
    expect(getStreamParams()).toMatchObject({ stop: ["\n\n"] });

    await dispatchChat(chatRequest({ stop: ["User:", "Assistant:"] }));
    expect(getStreamParams()).toMatchObject({ stop: ["User:", "Assistant:"] });

    await dispatchChat(chatRequest());
    expect(getStreamParams()).toBeUndefined();

    for (const stop of [["a", "b", "c", "d", "e"], [""], [123], {}]) {
      await expectRejectedChat(chatRequest({ stop }), /stop/);
    }
  });

  it.each([
    [
      "resolved terminal failure",
      { error: { kind: "incomplete_turn", message: "raw provider detail should stay private" } },
      "failed",
      500,
    ],
    ["error stop", { stopReason: "error" }, "failed", 500],
    [
      "run-budget timeout without error metadata",
      { aborted: false, timeoutPhase: "provider", providerStarted: true },
      "failed",
      500,
    ],
    ["completed run with an error payload", {}, "completed", 200],
  ] as const)("uses the recorded outcome for %s", async (_name, meta, outcome, status) => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce(
      recordAgentRunTerminalOutcome(
        { payloads: [{ text: "Command may have changed state", isError: true }], meta },
        outcome,
      ) as never,
    );

    const res = await postChatCompletions(enabledPort);
    expect(res.status).toBe(status);
    const body = await res.text();
    if (status === 500) {
      expect(JSON.parse(body)).toEqual({ error: { message: "internal error", type: "api_error" } });
      expect(body).not.toContain("raw provider detail should stay private");
    }
  });

  it.each(streamingFailureCases)(
    "rejects resolved streaming agent failures from $label",
    async ({ meta, expectedPhase, producerTerminal }) => {
      let runId: string | undefined;
      const { terminals, unsubscribe } = captureStreamingTerminals(() => runId);
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (options: unknown) => {
        runId = (options as { runId?: string }).runId;
        if (!runId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        return emitResolvedStreamingFailure(runId, { meta, producerTerminal });
      }) as never);

      try {
        const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        });
        const finishReasons: Array<string | null> = [];
        const content: string[] = [];
        await expect(async () => {
          for await (const chunk of stream) {
            finishReasons.push(...chunk.choices.map((choice) => choice.finish_reason));
            content.push(...chunk.choices.map((choice) => choice.delta.content ?? ""));
          }
        }).rejects.toMatchObject({
          error: { message: "internal error", type: "api_error" },
        });
        expect(finishReasons).not.toContain("stop");
        expect(content.join("")).toBe("partial answer");
        expect(terminals).toEqual([
          {
            phase: producerTerminal ? expectedPhase : "error",
            status: producerTerminal && meta.timeoutPhase ? "timeout" : "error",
          },
        ]);
      } finally {
        unsubscribe();
      }
    },
  );

  it("forwards response_format into streamParams", async () => {
    const getStreamParams = () => firstAgentCommandOptions()?.streamParams;

    await dispatchChat(chatRequest({ response_format: { type: "json_object" } }), undefined, [
      { text: "{}" },
    ]);
    expect(getStreamParams()).toMatchObject({ responseFormat: { type: "json_object" } });

    await dispatchChat(
      chatRequest({
        response_format: {
          type: "json_schema",
          json_schema: { name: "test", schema: { type: "object" } },
        },
      }),
      undefined,
      [{ text: "{}" }],
    );
    expect(getStreamParams()).toMatchObject({
      responseFormat: { type: "json_schema" },
    });

    await dispatchChat(chatRequest({ response_format: { type: "text" } }));
    expect(getStreamParams()).toMatchObject({ responseFormat: { type: "text" } });

    await dispatchChat(chatRequest());
    expect(getStreamParams()).toBeUndefined();

    await expectRejectedChat(chatRequest({ response_format: { type: "xml" } }), /response_format/);
  });

  it.each([
    {
      name: "a split custom XML opener",
      deltas: ["<", "xiaohai-banli>milk tea</", "xiaohai-banli>"],
      expected: "<xiaohai-banli>milk tea</xiaohai-banli>",
    },
    {
      name: "literal script-like content",
      deltas: ["<", "script>alert('literal')</", "script>"],
      expected: "<script>alert('literal')</script>",
    },
  ])("preserves $name through the official OpenAI SDK SSE stream", async ({ deltas, expected }) => {
    mockAgentRun(async (runId) => {
      const { session, emit } = createStubSessionHarness();
      subscribeEmbeddedAgentSession({ session, runId });
      emit({ type: "message_start", message: { role: "assistant" } });
      for (const delta of deltas) {
        emitAssistantTextDelta({ emit, delta });
      }
      return { payloads: [{ text: expected }] };
    });

    const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Preserve the literal output." }],
      stream: true,
    });
    const { content, finishReasons } = await readSdkStream(stream);

    expect(content).toBe(expected);
    expect(finishReasons.at(-1)).toBe("stop");
  });

  it.each(
    assistantSnapshotCases({
      name: "buffered leading content in cumulative assistant snapshots",
      events: [
        {
          text: "<xiaohai-banli>milk tea</xiaohai-banli>",
          delta: "xiaohai-banli>milk tea</xiaohai-banli>",
        },
      ],
      expected: "<xiaohai-banli>milk tea</xiaohai-banli>",
    }),
  )(
    "preserves $name in official SDK assistant streams",
    async ({ events, expected, resultTexts }) => {
      mockAgentRun(async (runId) => {
        for (const data of events) {
          emitAgentEvent({ runId, stream: "assistant", data });
        }
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return { payloads: (resultTexts ?? [expected]).map((text) => ({ text })) };
      });

      const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
        model: "openclaw",
        messages: [{ role: "user", content: "Preserve the full snapshot." }],
        stream: true,
      });
      const { content, finishReasons } = await readSdkStream(stream);

      expect(content).toBe(expected);
      expect(finishReasons.at(-1)).toBe("stop");
    },
  );

  it.each([false, true])(
    "flushes same-turn assistant microtasks before the SSE done frame (held tools=%s)",
    async (heldTools) => {
      mockAgentRun((runId) => {
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { delta: "start ", ...(heldTools ? { itemId: "answer-1" } : {}) },
        });
        const result = Promise.resolve({
          payloads: heldTools ? [] : [{ text: "start finish" }],
          ...(heldTools
            ? {
                meta: {
                  stopReason: "tool_calls",
                  pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
                },
              }
            : {}),
        });
        void result.then(() => {
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          void Promise.resolve().then(() => {
            emitAgentEvent({
              runId,
              stream: "assistant",
              data: heldTools
                ? {
                    itemId: "answer-2",
                    text: "start finish",
                    delta: "",
                    replace: true,
                    replaceable: true,
                  }
                : { delta: "finish" },
            });
          });
        });
        return result;
      });

      const res = await postChatCompletions(
        enabledPort,
        chatRequest({ stream: true }, "Finish the streamed response."),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const data = parseSseDataLines(await res.text());
      expect(data.at(-1)).toBe("[DONE]");
      const chunks = parseChunks(data);
      const content = streamContent(chunks);
      expect(content).toBe("start finish");
      const finishChoice = streamChoices(chunks).at(-1);
      expect(finishChoice?.finish_reason).toBe(heldTools ? "tool_calls" : "stop");
      if (heldTools) {
        const choices = streamChoices(chunks);
        const textIndex = choices.findLastIndex(
          (choice) => typeof (choice.delta as { content?: unknown })?.content === "string",
        );
        const toolIndex = choices.findIndex((choice) =>
          Array.isArray((choice.delta as { tool_calls?: unknown })?.tool_calls),
        );
        expect(toolIndex).toBeGreaterThan(textIndex);
      }
    },
  );

  it.each([
    { name: "resolved", reject: false, consumer: "SDK" },
    { name: "rejected", reject: true, consumer: "SDK" },
    { name: "rejected", reject: true, consumer: "raw HTTP" },
  ])(
    "preserves streaming failure when an error lifecycle precedes a $name run ($consumer)",
    async ({ reject, consumer }) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      mockAgentRun(async (runId) => {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "partial answer" } });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "All model fallback candidates failed" },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "A later lifecycle event must not replace the failure" },
        });
        if (reject) {
          throw new Error("private upstream failure");
        }
        return usageResult("partial answer", { usage: { input: 11, output: 7, total: 18 } });
      }, true);

      const request = {
        model: "openclaw",
        messages: [{ role: "user" as const, content: "Report the provider failure." }],
        stream: true as const,
      };
      const stream =
        consumer === "SDK"
          ? await createOpenAiHttpTestClient(enabledPort).chat.completions.create(request)
          : await postChatCompletions(enabledPort, request);
      const choices: OpenAI.ChatCompletionChunk["choices"] = [];
      const expectedError = { message: "All model fallback candidates failed", type: "api_error" };

      if (stream instanceof Response) {
        choices.push(...(await readRawChatCompletionStream(stream, expectedError)));
      } else {
        await expect(async () => {
          for await (const chunk of stream) {
            choices.push(...chunk.choices);
          }
        }).rejects.toMatchObject(expectedError);
      }

      expect(
        choices.flatMap((choice) =>
          typeof choice.delta.content === "string" ? [choice.delta.content] : [],
        ),
      ).toEqual(["partial answer"]);
      expect(choices.every((choice) => choice.finish_reason === null)).toBe(true);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
    },
  );

  it("keeps embedded late commentary append-only while the final answer streams", async () => {
    agentCommandMock.mockImplementationOnce(emitEmbeddedLateCommentary);
    const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Inspect the workspace and summarize it." }],
      stream: true,
    });
    const content: string[] = [];
    const finishReasons: Array<string | null> = [];
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        content.push(choice.delta.content ?? "");
        finishReasons.push(choice.finish_reason);
      }
    }
    expect(content.join("")).toBe("I will inspect the workspace.\n\nThe check is complete.");
    expect(finishReasons.at(-1)).toBe("stop");
  });

  it.each(
    incompatibleReplacementCases.toSpliced(6, 0, {
      name: "rewritten then explicitly restored",
      replacementText: "final answer",
      recoveryText: "draft answer",
    }),
  )("fails an official SDK stream when streamed text is $name", async (scenario) => {
    const { previousText = "draft answer" } = scenario;
    mockAgentRun(async (runId) => {
      return emitIncompatibleAssistantReplacement(runId, scenario, "");
    }, true);

    const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Reject an incompatible replacement snapshot." }],
      stream: true,
    });
    const deliveredContent: string[] = [];
    const finishReasons: Array<string | null> = [];
    await expect(async () => {
      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (typeof choice.delta.content === "string") {
            deliveredContent.push(choice.delta.content);
          }
          finishReasons.push(choice.finish_reason);
        }
      }
    }).rejects.toMatchObject({
      message: "Assistant output cannot be represented as an append-only response stream.",
      type: "api_error",
    });
    expect(deliveredContent).toEqual([previousText]);
    expect(finishReasons).not.toContain("stop");
  });

  it.each(compatibleReplacementCases)(
    "keeps official SDK text consistent for $name",
    async (scenario) => {
      const { resultText, replacementText = "final answer" } = scenario;
      mockAgentRun(async (runId) => {
        return emitCompatibleAssistantReplacement(runId, scenario);
      }, true);

      const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
        model: "openclaw",
        messages: [{ role: "user", content: "Preserve an append-compatible replacement." }],
        stream: true,
      });
      const { content: deliveredContent, finishReasons } = await readSdkStream(stream);
      expect(deliveredContent).toBe(resultText ?? replacementText);
      expect(finishReasons.at(-1)).toBe("stop");
    },
  );

  it.each(
    [
      {
        name: "the corrected final payload",
        provisional: "Working...",
        replacement: "Done.",
        payloads: [{ text: "Done." }],
        expected: "Done.",
      },
      {
        name: "all finalized payloads",
        provisional: "First.Second.",
        payloads: [{ text: "First." }, { text: "Second." }],
        expected: "First.\n\nSecond.",
      },
      {
        name: "streamed commentary when the final payload is empty",
        provisional: "Working...",
        payloads: [],
        expected: "Working...",
      },
      {
        name: "an explicit empty final payload",
        provisional: "Working...",
        payloads: [{ text: "" }],
        expected: "",
      },
      {
        name: "the finalized held replacement",
        provisional: "Working...",
        replacement: "Done.",
        replaceable: true,
        payloads: [{ text: "Final tool prose." }],
        expected: "Final tool prose.",
      },
    ].flatMap((scenario, index) =>
      (index === 0 ? (["required", "pinned"] as const) : (["required"] as const)).map((mode) => ({
        scenario,
        mode,
      })),
    ),
  )("uses $scenario.name for $mode tool-stream terminal commentary", async ({ scenario, mode }) => {
    mockAgentRun(async (runId) => {
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: scenario.provisional, delta: scenario.provisional },
      });
      if (scenario.replacement) {
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: {
            text: scenario.replacement,
            delta: "",
            replace: true,
            phase: "final_answer",
            ...(scenario.replaceable ? { itemId: "held-item", replaceable: true } : {}),
          },
        });
      }
      return toolResult(scenario.payloads, [weatherCall()]);
    });

    const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
      model: "openclaw",
      messages: [{ role: "user", content: "Check the weather." }],
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      tool_choice:
        mode === "required" ? "required" : { type: "function", function: { name: "get_weather" } },
    });
    let content = "";
    const finishReasons: string[] = [];
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        content += choice.delta.content ?? "";
        if (choice.finish_reason) {
          finishReasons.push(choice.finish_reason);
        }
      }
    }
    expect(content).toBe(scenario.expected);
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  it.each([
    ["successful completion without a provider terminal", false, false, "hello"],
    ["successful completion with a provider terminal", false, true, "hello"],
    ["internal agent error without a provider terminal", true, false, "internal error"],
    ["internal agent error with a provider terminal", true, true, "Agent run failed"],
  ] as const)(
    "separates streamed content from the terminal finish for %s",
    async (_name, fail, providerTerminal, expected) => {
      const protocolError = fail;
      const idleRootCount = getActiveGatewayRootWorkCount();
      const terminalAdmission = createDeferred<{ active: number }>();
      const continueAgent = createDeferred();
      const lifecycleTerminals: string[] = [];
      let activeRunId: string | undefined;
      const unsubscribe = onAgentEvent((event) => {
        const phase = event.data?.phase;
        if (event.runId !== activeRunId || event.stream !== "lifecycle") {
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        lifecycleTerminals.push(phase);
        // Agent settlement schedules the terminal in a later microtask. The
        // request must remain admitted until Node finishes the actual stream.
        const active = getActiveGatewayRootWorkCount();
        terminalAdmission.resolve({ active });
      });
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming chat-completion run ID");
        }
        await continueAgent.promise;
        if (fail) {
          if (providerTerminal) {
            emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "error" } });
          }
          throw new Error("private upstream failure");
        }
        const result = buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["he", "llo"],
          text: expected,
        });
        if (providerTerminal) {
          emitAgentEvent({ runId: activeRunId, stream: "lifecycle", data: { phase: "end" } });
        }
        return result;
      }) as never);

      try {
        const request = {
          model: "openclaw",
          messages: [{ role: "user" as const, content: "Return a complete streamed response." }],
          stream: true as const,
        };
        const stream =
          await createOpenAiHttpTestClient(enabledPort).chat.completions.create(request);
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continueAgent.resolve();

        const choices: Array<{
          delta: { content?: string | null };
          finish_reason: string | null;
        }> = [];
        const expectedError = { message: expected, type: "api_error" };
        const consumeStream = async () => {
          for await (const chunk of stream) {
            choices.push(...chunk.choices);
          }
        };
        if (protocolError) {
          await expect(consumeStream()).rejects.toMatchObject(expectedError);
        } else {
          await consumeStream();
        }

        const admission = await terminalAdmission.promise;
        expect(admission.active).toBe(idleRootCount + 1);
        expect(lifecycleTerminals).toEqual([fail ? "error" : "end"]);

        const contentChoices = choices.filter((choice) => typeof choice.delta.content === "string");
        expect(contentChoices.map((choice) => choice.delta.content).join("")).toBe(
          protocolError ? "" : expected,
        );
        expect(contentChoices.every((choice) => choice.finish_reason === null)).toBe(true);

        const terminalChoices = choices.filter((choice) => choice.finish_reason === "stop");
        expect(terminalChoices).toHaveLength(protocolError ? 0 : 1);
        if (!protocolError) {
          expect(terminalChoices[0]?.delta).toEqual({});
          expect(choices.at(-1)).toEqual(terminalChoices[0]);
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
      } finally {
        continueAgent.resolve();
        unsubscribe();
      }
    },
  );

  it.each([{ name: "a string", stream: "false" }])(
    "rejects $name stream mode before dispatching an agent",
    async ({ stream }) => {
      agentCommandMock.mockClear();
      const response = await postChatCompletions(enabledPort, chatRequest({ stream }));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({
        error: { type: "invalid_request_error", message: expect.stringContaining("stream") },
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("keeps one created timestamp across every streamed completion chunk", async () => {
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      mockAgentRun(async (runId) => {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "commentary" } });
        return toolResult(
          [{ text: "commentary" }],
          [{ id: "call_1", name: "lookup", arguments: JSON.stringify({ q: "x".repeat(300) }) }],
          { usage: { input: 4, output: 1, total: 5 } },
        );
      });

      const response = await postChatCompletions(
        enabledPort,
        chatRequest({ stream: true, stream_options: { include_usage: true } }),
      );
      expect(response.status).toBe(200);
      const chunks = parseSseDataLines(await response.text())
        .filter((data) => data !== "[DONE]")
        .map((data) => JSON.parse(data) as { created?: number });

      expect(chunks.length).toBeGreaterThanOrEqual(6);
      expect(chunks.every((chunk) => typeof chunk.created === "number")).toBe(true);
      expect(new Set(chunks.map((chunk) => chunk.created))).toEqual(new Set([chunks[0]?.created]));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("streams SSE chunks when stream=true", async () => {
    const port = enabledPort;

    {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
        buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["hi", "hi"],
          text: "hihi",
        })) as never);

      const res = await postChatCompletions(port, chatRequest({ stream: true }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

      const text = await res.text();
      const data = parseSseDataLines(text);
      expect(data[data.length - 1]).toBe("[DONE]");

      const jsonChunks = parseChunks(data);
      expect(jsonChunks.map((chunk) => chunk.object)).toContain("chat.completion.chunk");
      const allContent = streamContent(jsonChunks);
      expect(allContent).toBe("hihi");
      const contentChoices = streamChoices(jsonChunks).filter(
        (choice) => typeof choice.delta.content === "string",
      );
      expect(contentChoices.every((choice) => choice.finish_reason === null)).toBe(true);
      const stopChoices = streamChoices(jsonChunks).filter(
        (choice) => choice.finish_reason === "stop",
      );
      expect(stopChoices).toHaveLength(1);
      expect(stopChoices[0]?.delta).toEqual({});
      const usageChunks = jsonChunks.filter((c) => "usage" in c);
      expect(usageChunks).toHaveLength(0);
    }

    for (const { payloads, expected } of [
      { payloads: [{ text: "hello" }], expected: "hello" },
      { payloads: [{ text: "" }, {}], expected: "No response from OpenClaw." },
      {
        payloads: [{ text: "First." }, {}, { text: "" }, { text: "Second." }],
        expected: "First.\n\nSecond.",
      },
    ]) {
      mockAgentResult({
        payloads,
      });

      const fallbackRes = await postChatCompletions(port, chatRequest({ stream: true }));
      expect(fallbackRes.status).toBe(200);
      const fallbackText = await fallbackRes.text();
      expect(fallbackText).toContain("[DONE]");
      const fallbackContent = streamContent(parseChunks(parseSseDataLines(fallbackText)));
      expect(fallbackContent).toBe(expected);
    }

    {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) =>
        buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["plain text despite required"],
          text: "plain text despite required",
        })) as never);

      const requiredFailureRes = await postChatCompletions(
        port,
        chatRequest({
          stream: true,
          tool_choice: "required",
          tools: [functionTool("get_weather", "Get weather")],
        }),
      );
      expect(requiredFailureRes.status).toBe(200);
      const requiredFailureText = await requiredFailureRes.text();
      expect(requiredFailureText).toContain("[DONE]");
      expect(requiredFailureText).toContain("tool_choice=required was not satisfied");
      expect(requiredFailureText).not.toContain("plain text despite required");
    }

    for (const includeUsage of [false, true]) {
      mockAgentResult(
        toolResult(
          [{ text: "Let me check that." }],
          [weatherCall()],
          includeUsage ? { usage: { input: 12, output: 3, total: 15 } } : undefined,
        ),
      );
      const toolCallRes = await postChatCompletions(
        port,
        chatRequest({
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        }),
      );
      expect(toolCallRes.status).toBe(200);
      const toolCallText = await toolCallRes.text();
      const toolCallData = parseSseDataLines(toolCallText);
      const toolCallChunks = parseChunks(toolCallData);
      const choices = streamChoices(toolCallChunks);
      const toolCallDeltaRecords = choices.flatMap((choice) => choice.delta.tool_calls ?? []);
      expect(toolCallDeltaRecords).toContainEqual(
        expect.objectContaining({
          id: "call_1",
          type: "function",
          function: expect.objectContaining({ name: "get_weather" }),
        }),
      );
      const argsJoined = toolCallDeltaRecords
        .filter((record) => record.index === 0)
        .map((record) => record.function?.arguments ?? "")
        .join("");
      expect(argsJoined).toBe('{"city":"Taipei"}');
      expect(choices.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);
      if (includeUsage) {
        const usageChunk = toolCallChunks.find((chunk) => "usage" in chunk);
        expect(usageChunk?.choices).toEqual([]);
        expect(usageChunk?.usage).toEqual({
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
        });
      }
      expect(toolCallData.at(-1)).toBe("[DONE]");
    }

    {
      agentCommandMock.mockClear();
      const lateResult = toolResult([{ text: "Let me check that." }], [weatherCall()]);
      const completion = createDeferred<typeof lateResult>();
      agentCommandMock.mockImplementationOnce(((opts: unknown) => {
        const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "Let me check that." } });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return completion.promise;
      }) as never);

      const lateToolCallRes = await postChatCompletions(port, chatRequest({ stream: true }));
      expect(lateToolCallRes.status).toBe(200);
      if (!lateToolCallRes.body) {
        throw new Error("expected streaming response body");
      }
      const reader = lateToolCallRes.body.getReader();
      const decoder = new TextDecoder();
      let lateToolCallText = "";
      while (!lateToolCallText.includes("Let me check that.")) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("stream ended before early assistant delta");
        }
        lateToolCallText += decoder.decode(value, { stream: true });
      }
      expect(lateToolCallText).not.toContain("[DONE]");

      completion.resolve(lateResult);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          lateToolCallText += decoder.decode();
          break;
        }
        lateToolCallText += decoder.decode(value, { stream: true });
      }
      const lateToolCallData = parseSseDataLines(lateToolCallText);
      const lateToolCallChunks = parseChunks(lateToolCallData);
      const finishChunk = streamChoices(lateToolCallChunks).find(
        (choice) => choice.finish_reason === "tool_calls",
      );
      if (!finishChunk) {
        throw new Error("expected late tool_calls finish chunk");
      }
      const anyToolCalls = lateToolCallChunks.some((chunk) => {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        return Array.isArray(delta.tool_calls);
      });
      expect(anyToolCalls).toBe(true);
    }

    {
      agentCommandMock.mockClear();
      agentCommandMock.mockRejectedValueOnce(new Error("client tool name conflict: exec"));

      const toolConflictRes = await postChatCompletions(
        port,
        chatRequest({
          stream: true,
          tools: [functionTool("exec", "conflicts with a built-in tool")],
        }),
      );
      expect(toolConflictRes.status).toBe(200);
      const toolConflictText = await toolConflictRes.text();
      const toolConflictData = parseSseDataLines(toolConflictText);
      expect(toolConflictData[toolConflictData.length - 1]).toBe("[DONE]");

      const toolConflictChunks = parseChunks(toolConflictData);
      const protocolError = toolConflictChunks.find(
        (chunk) =>
          typeof chunk.error === "object" &&
          ((chunk.error as { type?: unknown }).type ?? "") === "invalid_request_error" &&
          ((chunk.error as { message?: unknown }).message ?? "") === "invalid tool configuration",
      );
      if (!protocolError) {
        throw new Error("expected invalid tool configuration protocol error");
      }
      const stopChoice = streamChoices(toolConflictChunks).find(
        (choice) => choice.finish_reason === "stop",
      );
      expect(stopChoice).toBeUndefined();
    }

    {
      agentCommandMock.mockClear();
      agentCommandMock.mockRejectedValueOnce(new Error("boom"));

      const errorRes = await postChatCompletions(port, chatRequest({ stream: true }));
      expect(errorRes.status).toBe(200);
      const errorText = await errorRes.text();
      const errorData = parseSseDataLines(errorText);
      expect(errorData[errorData.length - 1]).toBe("[DONE]");

      const errorChunks = parseChunks(errorData);
      const choices = streamChoices(errorChunks);
      expect(errorChunks.filter((chunk) => "error" in chunk)).toEqual([
        { error: { message: "internal error", type: "api_error" } },
      ]);
      expect(choices.some((choice) => Boolean(choice.delta.content))).toBe(false);
      expect(choices.some((choice) => choice.finish_reason === "stop")).toBe(false);
      expect(errorText).not.toContain("boom");
    }
  });

  it.each([
    { name: "empty arguments", expectedArguments: "" },
    ...[{ astral: "😀", boundary: 255 }].map(({ astral, boundary }) => ({
      name: `${astral} at UTF-16 boundary ${boundary}`,
      expectedArguments: JSON.stringify({
        value: `${"a".repeat(boundary - '{"value":"'.length)}${astral}tail`,
      }),
    })),
  ])("keeps streamed tool-call arguments well-formed ($name)", async ({ expectedArguments }) => {
    mockAgentResult(
      toolResult(
        [{ text: "Calling the tool." }],
        [
          {
            id: "call_1",
            name: "read_value",
            arguments: expectedArguments,
          },
        ],
      ),
    );

    const res = await postChatCompletions(enabledPort, chatRequest({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");

    const chunks = parseChunks(data);
    const choices = streamChoices(chunks);
    const argumentDeltas = choices
      .flatMap((choice) => choice.delta.tool_calls ?? [])
      .map((toolCall) => toolCall.function?.arguments)
      .filter((argumentsDelta): argumentsDelta is string => typeof argumentsDelta === "string");

    expect(argumentDeltas.length).toBeGreaterThan(1);
    for (const argumentsDelta of argumentDeltas) {
      expect(new TextDecoder().decode(new TextEncoder().encode(argumentsDelta))).toBe(
        argumentsDelta,
      );
    }
    expect(argumentDeltas.join("")).toBe(expectedArguments);
    expect(choices.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);
  });

  it(
    "sends an initial SSE chunk before a streaming agent run settles",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      let settled = false;
      const firstChunk = new Promise<string>((resolve, reject) => {
        const clientReq = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer secret",
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"] ?? "").toContain("text/event-stream");
            res.setEncoding("utf8");
            res.once("data", (chunk) => {
              settled = true;
              resolve(String(chunk));
              clientReq.destroy();
            });
          },
        );
        clientReq.on("error", (err) => {
          if (!settled) {
            reject(err);
          }
        });
        clientReq.setTimeout(2_000, () => {
          if (!settled) {
            settled = true;
            clientReq.destroy(new Error("timed out waiting for first SSE chunk"));
          }
        });
        clientReq.end(JSON.stringify(chatRequest({ stream: true })));
      });

      await expect(firstChunk).resolves.toContain('"role":"assistant"');
      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("keeps streamed agent work admitted after the HTTP handler returns", async () => {
    const idleRootCount = getActiveGatewayRootWorkCount();
    const continueAgent = createDeferred();
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce((async () => {
      await continueAgent.promise;
      const queued = await enqueueCommandInLane("openai-http-admission-probe", async () => true);
      return { payloads: [{ text: queued ? "answer queued" : "unreachable" }] };
    }) as never);

    const res = await postChatCompletions(enabledPort, chatRequest({ stream: true }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    continueAgent.resolve();

    const streamed = parseSseDataLines(await res.text()).join("\n");
    expect(streamed).toContain("answer queued");
    expect(streamed).not.toContain("Error: internal error");
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
  });

  it.each(bufferedReplacementCases)(
    "buffers replaceable assistant events through $name",
    async ({ replacement, finalText, expected }) => {
      mockAgentRun(async (runId) => {
        return emitBufferedAssistantReplacement(runId, { replacement, finalText });
      });

      const stream = await createOpenAiHttpTestClient(enabledPort).chat.completions.create({
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });

      const { content, finishReasons } = await readSdkStream(stream);
      expect(content).toBe(expected);
      expect(finishReasons.at(-1)).toBe("stop");
    },
  );

  it.each([
    [
      "aggregate-only usage",
      false,
      { total: 123 },
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 123 },
    ],
    [
      "usage arriving after lifecycle end",
      true,
      { input: 7, output: 3, total: 10 },
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    ],
  ] as const)("finalizes a stream with %s", async (_name, delayed, usage, expected) => {
    mockAgentRun((runId) => {
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
      const result = usageResult("hello", { usage });
      if (!delayed) {
        return Promise.resolve(result);
      }
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
      return new Promise((resolve) => {
        setTimeout(() => resolve(result), 100);
      });
    });
    const res = await postChatCompletions(
      enabledPort,
      chatRequest({ stream: true, stream_options: { include_usage: true } }),
    );
    expect(res.status).toBe(200);
    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");
    expect(parseChunks(data).find((chunk) => "usage" in chunk)?.usage).toEqual(expected);
  });

  it("preserves declared owner identity for streaming and non-streaming private callers", async () => {
    await expectDeclaredHttpOwnerIdentity({
      post: (stream, headers) => postChatCompletions(enabledPort, chatRequest({ stream }), headers),
      consume: (response) => response.text(),
      senderIsOwner: () => firstAgentCommandOptions()?.senderIsOwner,
    });
  });

  it.each([
    { name: "streaming", stream: true, includeUsage: false },
    { name: "usage-enabled streaming", stream: true, includeUsage: true },
    { name: "non-streaming", stream: false, includeUsage: false },
  ])(
    "aborts and retains cleanup admission when $name client disconnects",
    { timeout: 15_000 },
    async ({ stream, includeUsage }) => {
      const port = enabledPort;
      const idleRootCount = getActiveGatewayRootWorkCount();
      const agentAborted = createDeferred();
      const finishAgentCleanup = createDeferred();
      const cleanupAdmissionClosed = createDeferred<boolean>();
      let serverAbortSignal: AbortSignal | undefined;

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        serverAbortSignal = signal;
        if (includeUsage) {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        }
        if (signal?.aborted) {
          agentAborted.resolve();
        } else {
          signal?.addEventListener("abort", () => agentAborted.resolve(), { once: true });
        }
        await agentAborted.promise;
        cleanupAdmissionClosed.resolve(isGatewaySubordinateWorkAdmissionClosed());
        await finishAgentCleanup.promise;
        return undefined;
      });

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify(
          chatRequest({
            ...(stream ? { stream: true } : {}),
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          }),
        ),
      );

      await vi.waitFor(() => {
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
      });

      try {
        clientReq.destroy();

        await vi.waitFor(() => expect(serverAbortSignal?.aborted).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });
        expect(await cleanupAdmissionClosed.promise).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount + 1);
      } finally {
        finishAgentCleanup.resolve();
      }

      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount), {
        timeout: 5_000,
        interval: 50,
      });
    },
  );

  // Keep this last: it verifies shutdown of the shared server.
  it("binds the Gateway lifecycle resolver to chat-completion runs", async () => {
    let resolveGatewayContext: ReturnType<typeof getGatewayContextResolver>;
    try {
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
        const admittedRunContext = {};
        const onAdmittedRunContext = (opts as FirstAgentCommandOptions).onAdmittedRunContext;
        expect(onAdmittedRunContext).toBeTypeOf("function");
        await onAdmittedRunContext?.(admittedRunContext);
        resolveGatewayContext = getGatewayContextResolver(admittedRunContext);
        return { payloads: [{ text: "hello" }] } as never;
      });

      const res = await postChatCompletions(enabledPort);

      expect(res.status).toBe(200);
      await res.text();
      const context = resolveGatewayContext?.();
      expect(context?.resolveGatewayContext).toBe(resolveGatewayContext);
    } finally {
      await enabledServer.close({ reason: "chat-completion resolver lifecycle test done" });
    }
    expect(resolveGatewayContext?.()).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

// These configurations own their Gateway after the shared server has closed.
describe("OpenAI-compatible HTTP API (e2e) with independent Gateways", () => {
  it("returns 429 for repeated failed auth when gateway.auth.rateLimit is configured", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
    };
    await withGatewayServer(
      async ({ port }) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        };
        const body = {
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        };

        const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(first.status).toBe(401);

        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
      },
      {
        serverOptions: {
          host: "127.0.0.1",
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: true,
        },
      },
    );
  });

  it.each(["trusted-proxy", "token"] as const)(
    "preserves %s authority when mutating another operator session",
    async (authMethod) => {
      await expectHttpForeignSessionAuthority({
        authMethod,
        ownerEmail: "session-owner@example.test",
        sessionKey: "agent:main:foreign-openai-http",
        sessionId: "foreign-openai-http",
        closeReason: "openai operator role session sharing test done",
        startServer: async (port, auth) => {
          return await startGatewayServer(port, {
            host: "127.0.0.1",
            auth,
            controlUiEnabled: false,
            openAiChatCompletionsEnabled: true,
          });
        },
        writeGatewayConfig,
        post: (port, headers) =>
          postChatCompletions(port, chatRequest({}, "mutate foreign session"), headers),
      });
    },
  );

  it("preserves verified trusted-proxy owner identity for both response modes", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
      async () => {
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        const previousGatewayAuth = testState.gatewayAuth;
        const trustedProxyAuth = browserProxyAuth();
        testState.gatewayAuth = trustedProxyAuth;
        try {
          await writeGatewayConfig({
            gateway: {
              auth: trustedProxyAuth,
              trustedProxies: ["127.0.0.1"],
            },
          });
          resetConfigRuntimeState();
          const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
          const port = portClaim.port;
          server = await startClaimedGateway(portClaim, () =>
            startGatewayServer(port, {
              host: "127.0.0.1",
              auth: trustedProxyAuth,
              controlUiEnabled: false,
              openAiChatCompletionsEnabled: true,
            }),
          );

          const incognitoSessionKey = "agent:main:dashboard:incognito-openai-http";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: incognitoSessionKey },
            {
              sessionId: "session-incognito-openai-http",
              updatedAt: 1,
              incognito: true,
              visibility: "shared",
            },
          );

          for (const stream of [false, true]) {
            for (const { scopes, senderIsOwner } of [
              { scopes: "operator.write", senderIsOwner: false },
              { scopes: "operator.admin, operator.write", senderIsOwner: true },
            ]) {
              mockAgentResult({ payloads: [{ text: "hello" }] });

              const res = await postChatCompletions(port, chatRequest({ stream }), {
                "x-forwarded-for": "198.51.100.42",
                "x-forwarded-proto": "https",
                "x-forwarded-user": "operator@example.com",
                "x-openclaw-scopes": scopes,
                "x-openclaw-sender-is-owner": "true",
              });

              expect(res.status).toBe(200);
              await res.text();
              expect(agentCommandMock).toHaveBeenCalledTimes(1);
              expect(firstAgentCommandOptions()?.senderIsOwner).toBe(senderIsOwner);
            }
          }

          const trustedProxyHeaders = {
            "x-forwarded-for": "198.51.100.42",
            "x-forwarded-proto": "https",
            "x-forwarded-user": "operator@example.com",
          };
          for (const requestedSessionKey of [
            incognitoSessionKey,
            "dashboard:incognito-openai-http",
          ]) {
            agentCommandMock.mockClear();
            const denied = await postChatCompletions(port, chatRequest(), {
              ...trustedProxyHeaders,
              "x-openclaw-scopes": "operator.write",
              "x-openclaw-session-key": requestedSessionKey,
            });
            expect(denied.status).toBe(403);
            await denied.text();
            expect(agentCommandMock).not.toHaveBeenCalled();
          }

          agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
          const allowed = await postChatCompletions(port, chatRequest(), {
            ...trustedProxyHeaders,
            "x-openclaw-scopes": "operator.admin, operator.write",
            "x-openclaw-session-key": "dashboard:incognito-openai-http",
          });
          expect(allowed.status).toBe(200);
          await allowed.text();
          expect(agentCommandMock).toHaveBeenCalledTimes(1);

          agentCommandMock.mockClear();
          const unauthorized = await postChatCompletions(port, chatRequest(), {
            "x-forwarded-for": "198.51.100.42",
            "x-forwarded-proto": "https",
            "x-openclaw-scopes": "operator.admin, operator.write",
            "x-openclaw-sender-is-owner": "true",
          });
          expect(unauthorized.status).toBe(401);
          await unauthorized.text();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          await server?.close({ reason: "openai trusted-proxy auth owner test done" });
          testState.gatewayAuth = previousGatewayAuth;
          await writeGatewayConfig({});
          resetConfigRuntimeState();
        }
      },
    );
  });

  it.each(["token", "password"] as const)(
    "preserves owner identity for streaming and non-streaming %s-authenticated callers",
    async (mode) => {
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const port = portClaim.port;
      const server = await startSharedSecretServer(portClaim, mode);
      try {
        await expectSharedSecretHttpOwnerIdentity({
          post: (stream, headers) =>
            postChatCompletions(port, chatRequest(stream === undefined ? {} : { stream }), headers),
          consume: (response) => response.text(),
          senderIsOwner: () => firstAgentCommandOptions()?.senderIsOwner,
        });
      } finally {
        await server.close({ reason: `openai ${mode} auth owner test done` });
      }
    },
  );
});
