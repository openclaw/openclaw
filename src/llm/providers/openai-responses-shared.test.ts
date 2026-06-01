import type {
  ResponseStreamEvent,
  Tool as OpenAIResponsesTool,
} from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import type { Context, Model, Tool } from "../types.js";
import {
  createResponsesAssistantOutput,
  convertResponsesMessages,
  processResponsesStream,
} from "./openai-responses-shared.js";
import { convertResponsesTools } from "./openai-responses-tools.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;

function expectResponsesFunctionTool(tool: OpenAIResponsesTool | undefined): ResponsesFunctionTool {
  expect(tool).toHaveProperty("type", "function");
  return tool as ResponsesFunctionTool;
}

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

describe("convertResponsesTools", () => {
  it("enables native strict OpenAI Responses tools and normalizes schemas", () => {
    const tools = [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: {},
      },
    ] satisfies Tool[];

    const converted = convertResponsesTools(tools, { model: nativeOpenAIModel });

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("downgrades incompatible native Responses schemas to strict false", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          },
        },
      ],
      { model: nativeOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("omits strict on proxy-like Responses routes but keeps schema normalization", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool).not.toHaveProperty("strict");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps tool order deterministic", () => {
    const zeta = {
      name: "zeta",
      description: "Z",
      parameters: {},
    } satisfies Tool;
    const alpha = {
      name: "alpha",
      description: "A",
      parameters: {},
    } satisfies Tool;

    expect(
      convertResponsesTools([zeta, alpha]).map((tool) => expectResponsesFunctionTool(tool).name),
    ).toEqual(["alpha", "zeta"]);
  });
});

describe("convertResponsesMessages", () => {
  const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

  it("omits phase-tagged assistant replay ids without reasoning", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Working...",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_commentary",
                  phase: "commentary",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).toMatchObject({
      phase: "commentary",
    });
    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).not.toHaveProperty("id");
  });

  it("omits raw signed assistant ids when the paired reasoning item is absent", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Earlier answer",
                textSignature: "msg_real_response_item_requiring_reasoning",
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "content" in item,
      ),
    ).not.toHaveProperty("id");
  });

  it("omits Responses replay item ids when requested by store-disabled callers", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false, replayResponsesItemIds: false },
    ) as unknown as Array<Record<string, unknown>>;

    const reasoningItem = input.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");

    const assistantMessage = input.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage).not.toHaveProperty("id");

    const functionCall = input.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });
});

describe("Azure OpenAI Responses content type support", () => {
  const azureModel = {
    id: "gpt-5.5",
    name: "GPT-5.5 (Azure)",
    api: "azure-openai-responses",
    provider: "azure",
    baseUrl: "https://test.openai.azure.com/openai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } satisfies Model<"azure-openai-responses">;

  it("supports Azure 'text' content type in addition to 'output_text'", () => {
    const input = convertResponsesMessages(
      azureModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: azureModel.api,
            provider: azureModel.provider,
            model: azureModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: "Azure response with text content type",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_azure_text",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      new Set(["azure", "azure-openai-responses"]),
      { includeSystemPrompt: false },
    );

    const assistantMessage = input.find(
      (item) => item && typeof item === "object" && "role" in item && item.role === "assistant",
    );

    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Azure response with text content type",
          annotations: [],
        },
      ],
      });
    });
  });

  it("processResponsesStream handles Azure 'text' content type streaming events", async () => {
    const azureModel = {
      id: "gpt-5.5",
      name: "GPT-5.5 (Azure)",
      api: "azure-openai-responses",
      provider: "azure",
      baseUrl: "https://test.openai.azure.com/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"azure-openai-responses">;

    // Simulate Azure Responses API stream with 'text' content type
    const azureEvents: ResponseStreamEvent[] = [
      {
        type: "response.created",
        response: {
          id: "resp_azure_123",
          status: "in_progress",
        } as any,
      },
      {
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_1",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.content_part.added",
        part: {
          type: "text", // Azure uses 'text' instead of 'output_text'
          text: "",
        },
      },
      {
        type: "response.text.delta", // Azure uses 'response.text.delta' instead of 'response.output_text.delta'
        delta: "Hello",
      },
      {
        type: "response.text.delta",
        delta: " from",
      },
      {
        type: "response.text.delta",
        delta: " Azure!",
      },
      {
        type: "response.content_part.done",
        part: {
          type: "text",
          text: "Hello from Azure!",
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_1",
          content: [
            {
              type: "text", // Azure content type
              text: "Hello from Azure!",
            },
          ],
          status: "completed",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_azure_123",
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        } as any,
      },
    ];

    const stream = new AssistantMessageEventStream();
    const output = createResponsesAssistantOutput(azureModel, "azure-openai-responses");
    const events: Array<{ type: string }> = [];

    // Mock the stream processing
    const processStream = async () => {
      for (const event of azureEvents) {
        await processResponsesStream(
          (async function* () {
            yield event;
          })(),
          output,
          stream,
          azureModel,
        );
      }
    };

    // Collect stream events
    stream.on("start", (data) => events.push({ type: "start" }));
    stream.on("text_start", (data) => events.push({ type: "text_start" }));
    stream.on("text_delta", (data) =>
      events.push({ type: "text_delta", delta: data.delta }),
    );
    stream.on("text_end", (data) =>
      events.push({ type: "text_end", content: data.content }),
    );
    stream.on("done", (data) => events.push({ type: "done" }));

    await processStream();

    // Verify that Azure 'text' content type was properly handled
    expect(events).toEqual([
      { type: "start" },
      { type: "text_start" },
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " from" },
      { type: "text_delta", delta: " Azure!" },
      { type: "text_end", content: "Hello from Azure!" },
      { type: "done" },
    ]);

    // Verify the final output contains the expected text
    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "Hello from Azure!",
    });

    // Verify usage was recorded
    expect(output.usage).toMatchObject({
      input: 10,
      output: 5,
      totalTokens: 15,
    });

    // Verify stop reason
    expect(output.stopReason).toBe("stop");
  });

  it("processResponsesStream handles mixed OpenAI and Azure content types", async () => {
    const openaiModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-responses">;

    // Simulate a stream with both output_text (OpenAI) and text (Azure) content types
    const mixedEvents: ResponseStreamEvent[] = [
      {
        type: "response.created",
        response: { id: "resp_mixed", status: "in_progress" } as any,
      },
      {
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          id: "msg_mixed_1",
          content: [],
          status: "in_progress",
        },
      },
      // First part uses OpenAI's output_text
      {
        type: "response.content_part.added",
        part: {
          type: "output_text",
          text: "",
        },
      },
      {
        type: "response.output_text.delta",
        delta: "Standard ",
      },
      {
        type: "response.output_text.delta",
        delta: "OpenAI ",
      },
      {
        type: "response.output_text.delta",
        delta: "response",
      },
      {
        type: "response.content_part.done",
        part: {
          type: "output_text",
          text: "Standard OpenAI response",
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "msg_mixed_1",
          content: [
            {
              type: "output_text",
              text: "Standard OpenAI response",
            },
          ],
          status: "completed",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_mixed",
          status: "completed",
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12,
          },
        } as any,
      },
    ];

    const stream = new AssistantMessageEventStream();
    const output = createResponsesAssistantOutput(openaiModel, "openai-responses");

    const processStream = async () => {
      for (const event of mixedEvents) {
        await processResponsesStream(
          (async function* () {
            yield event;
          })(),
          output,
          stream,
          openaiModel,
        );
      }
    };

    const collectedText: string[] = [];
    stream.on("text_delta", (data) => collectedText.push(data.delta));
    stream.on("text_end", (data) => collectedText.push(`[END:${data.content}]`));

    await processStream();

    // Verify OpenAI output_text content type still works
    expect(collectedText).toEqual([
      "Standard ",
      "OpenAI ",
      "response",
      "[END:Standard OpenAI response]",
    ]);

    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "Standard OpenAI response",
    });
  });
});
