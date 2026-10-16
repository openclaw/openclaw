import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import type { Api, Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { transformTransportMessages } from "./transport-message-transform.js";

const EXPECTED_FAILURE_MARKER =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";
const NO_CONTENT_PLACEHOLDER = "[assistant turn failed before producing content]";

function makeModel(api: Api, provider: string, id: string): Model {
  return {
    api,
    provider,
    id,
    name: id,
    input: [],
    output: [],
  } as unknown as Model;
}

type ToolResultMessage = Extract<Context["messages"][number], { role: "toolResult" }>;
const userMessage = (content: string, timestamp = Date.now()) => ({
  role: "user" as const,
  content,
  timestamp,
});
const text = (value: string) => ({ type: "text" as const, text: value });
const openai = makeModel("openai-responses", "openai", "gpt-5.4");
function toolResult(
  toolCallId: string,
  output: string,
  toolName = "read",
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [text(output)],
    isError,
    timestamp: Date.now(),
  };
}
function thinkingMessage(
  overrides: Partial<Extract<Context["messages"][number], { role: "assistant" }>>,
  thinking: string,
  thinkingSignature: string,
  visible?: string,
) {
  return {
    ...assistantToolCall("unused"),
    api: "anthropic-messages" as const,
    stopReason: "stop" as const,
    ...overrides,
    content: [
      { type: "thinking" as const, thinking, thinkingSignature },
      ...(visible ? [text(visible)] : []),
    ],
  };
}

function requireToolResultMessage(
  message: Context["messages"][number] | undefined,
): ToolResultMessage {
  if (!message || message.role !== "toolResult") {
    throw new Error(`expected toolResult message, got ${message?.role ?? "missing"}`);
  }
  return message;
}

function assistantToolCall(
  id: string,
  name = "read",
  stopReason: Extract<Context["messages"][number], { role: "assistant" }>["stopReason"] = "toolUse",
): Extract<Context["messages"][number], { role: "assistant" }> {
  return {
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.4",
    stopReason,
    timestamp: Date.now(),
    content: [{ type: "toolCall", id, name, arguments: {} }],
  } as Extract<Context["messages"][number], { role: "assistant" }>;
}

describe("transformTransportMessages synthetic tool-result policy", () => {
  it.each(["openai-completions"] as const)(
    "compacts sparse %s history without changing the source or sharing assistant arrays",
    (api) => {
      const hidden = makeAssistantMessageFixture({
        api,
        content: [{ type: "thinking", thinking: "unfinished reasoning" }],
      });
      const failed = makeAssistantMessageFixture({
        api,
        content: [{ type: "text", text: "unfinished answer" }],
      });
      const retained = makeAssistantMessageFixture({
        api,
        stopReason: "stop",
        content: [{ type: "text", text: "completed answer" }],
      });
      const user = userMessage("continue", 1);
      const messages: Context["messages"] = [];
      messages[1] = hidden;
      messages[3] = failed;
      messages[4] = retained;
      messages[6] = user;
      messages.length = 8;
      const original = structuredClone(messages);

      const result = transformTransportMessages(messages, makeModel(api, "openai", "test-model"));

      expect(result).toStrictEqual([
        { ...failed, content: [{ type: "text", text: EXPECTED_FAILURE_MARKER }] },
        retained,
        user,
      ]);
      const replayedAssistant = result[1];
      if (replayedAssistant?.role !== "assistant") {
        throw new Error("expected the completed assistant turn");
      }
      replayedAssistant.stopReason = "length";
      replayedAssistant.content.push({ type: "text", text: "replay-only addition" });
      result.pop();
      expect(messages).toStrictEqual(original);
    },
  );

  it("preserves unframed tool results only for a selected compaction replay window", () => {
    const model = openai;
    const messages = [
      assistantToolCall("call_early"),
      userMessage("continue"),
      assistantToolCall("call_after"),
      toolResult("call_early", "displaced retained result"),
      toolResult("call_before", "real result after compaction"),
    ] as Context["messages"];

    const normal = transformTransportMessages(messages, model);
    const compactionReplay = transformTransportMessages(messages, model, undefined, {
      preserveUnframedToolResults: true,
    });

    expect(normal.filter((message) => message.role === "toolResult")).toMatchObject([
      {
        toolCallId: "call_early",
        content: [{ type: "text", text: "displaced retained result" }],
      },
      { toolCallId: "call_after", content: [{ type: "text", text: "aborted" }] },
    ]);
    expect(compactionReplay.filter((message) => message.role === "toolResult")).toMatchObject([
      {
        toolCallId: "call_early",
        content: [{ type: "text", text: "displaced retained result" }],
      },
      { toolCallId: "call_after", content: [{ type: "text", text: "aborted" }] },
      {
        toolCallId: "call_before",
        content: [{ type: "text", text: "real result after compaction" }],
      },
    ]);
    expect(
      compactionReplay.filter(
        (message) => message.role === "toolResult" && message.toolCallId === "call_early",
      ),
    ).toHaveLength(1);
  });

  it("drops model-bound thinking for Fable/Mythos switches", () => {
    const result = transformTransportMessages(
      [
        thinkingMessage(
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          "model-bound thought",
          "sig_model_bound",
          "visible answer",
        ),
      ] as Context["messages"],
      makeModel("anthropic-messages", "anthropic", "claude-fable-5"),
    );

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });

  // Live-verified 2026-09-02 with thinking-binding-controls: these replays return
  // input_transformations: [] on claude-fable-5-1, so the earlier reasoning stays usable.
  it("keeps readable Claude thinking when moving onto Fable 5.1", () => {
    const result = transformTransportMessages(
      [
        thinkingMessage(
          { provider: "microsoft-foundry", model: "prod-primary", responseModel: "claude-opus-5" },
          "earlier reasoning",
          "sig_readable",
          "visible answer",
        ),
      ] as Context["messages"],
      makeModel("anthropic-messages", "anthropic", "claude-fable-5-1"),
    );

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "earlier reasoning", thinkingSignature: "sig_readable" },
        { type: "text", text: "visible answer" },
      ],
    });
  });

  it("normalizes malformed assistant content before transport conversion", () => {
    const objectContentMessages = [
      {
        ...assistantToolCall("call_object"),
        stopReason: "stop",
        content: { type: "text", text: "legacy object" },
      },
      userMessage("continue"),
    ] as unknown as Context["messages"];
    const objectResult = transformTransportMessages(objectContentMessages, openai);
    expect(objectResult[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "legacy object" }],
    });

    const nullContentMessages = [
      {
        ...assistantToolCall("call_null"),
        stopReason: "stop",
        content: null,
      },
      userMessage("continue"),
    ] as unknown as Context["messages"];
    const nullResult = transformTransportMessages(nullContentMessages, openai);
    expect(nullResult[0]).toMatchObject({ role: "assistant", content: [] });
    expect(nullResult[1]).toMatchObject({ role: "user" });
  });

  it("drops the no-content placeholder with hidden reasoning across a model change", () => {
    const failed = makeAssistantMessageFixture({
      model: "source-model",
      stopReason: "error",
      content: [
        { type: "text", text: NO_CONTENT_PLACEHOLDER },
        { type: "thinking", thinking: "hidden partial reasoning" },
      ],
    });
    const user = userMessage("what is the weather?", 3);
    expect(transformTransportMessages([failed, user], openai)).toEqual([user]);
  });

  it("drops max-token reasoning-only transport assistant turns before replay", () => {
    const messages: Context["messages"] = [
      thinkingMessage(
        {
          provider: "amazon-bedrock",
          api: "bedrock-converse-stream",
          model: "global.anthropic.claude-sonnet-4-6",
          stopReason: "length",
        },
        "partial hidden reasoning",
        "partial-signature",
      ),
      userMessage("retry after max token thinking"),
    ];

    const result = transformTransportMessages(
      messages,
      makeModel(
        "bedrock-converse-stream" as Api,
        "amazon-bedrock",
        "global.anthropic.claude-sonnet-4-6",
      ),
    );

    expect(result.map((msg) => msg.role)).toEqual(["user"]);
    expect(JSON.stringify(result)).not.toContain("partial-signature");
  });

  it("does not reassign a dropped errored turn's repeated-id result to an older turn", () => {
    const messages: Context["messages"] = [
      assistantToolCall("call_repeated"),
      assistantToolCall("call_repeated", "exec", "error"),
      toolResult("call_repeated", "failed turn output", "exec", true),
      userMessage("retry after error"),
    ];

    const result = transformTransportMessages(
      messages,
      makeModel("anthropic-messages", "anthropic", "claude-opus-4-6"),
    );

    expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(requireToolResultMessage(result[1])).toMatchObject({
      toolCallId: "call_repeated",
      isError: true,
      content: [{ type: "text", text: DEFAULT_MISSING_TOOL_RESULT_TEXT }],
    });
    expect(JSON.stringify(result)).not.toContain("failed turn output");
  });
});
