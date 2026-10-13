// Transport message transform tests cover replay cleanup for provider-specific
// tool-call/result sequencing before messages are sent back to transports.
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
      const user: Context["messages"][number] = {
        role: "user",
        content: "continue",
        timestamp: 1,
      };
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
    const model = makeModel("openai-responses", "openai", "gpt-5.4");
    const messages = [
      assistantToolCall("call_early"),
      { role: "user", content: "continue", timestamp: Date.now() },
      assistantToolCall("call_after"),
      {
        role: "toolResult",
        toolCallId: "call_early",
        toolName: "read",
        content: [{ type: "text", text: "displaced retained result" }],
        isError: false,
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call_before",
        toolName: "read",
        content: [{ type: "text", text: "real result after compaction" }],
        isError: false,
        timestamp: Date.now(),
      },
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

  it.each([
    {
      source: { provider: "anthropic", model: "claude-sonnet-4-6" },
      target: { provider: "anthropic", model: "claude-fable-5" },
    },
  ])("drops model-bound thinking for Fable/Mythos switches", ({ source, target }) => {
    const result = transformTransportMessages(
      [
        {
          role: "assistant",
          provider: source.provider,
          api: "anthropic-messages",
          model: source.model,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "model-bound thought",
              thinkingSignature: "sig_model_bound",
            },
            { type: "text", text: "visible answer" },
          ],
        },
      ] as Context["messages"],
      makeModel("anthropic-messages", target.provider, target.model),
    );

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });

  // Live-verified 2026-09-02 with thinking-binding-controls: these replays return
  // input_transformations: [] on claude-fable-5-1, so the earlier reasoning stays usable.
  it.each([
    {
      source: {
        provider: "microsoft-foundry",
        model: "prod-primary",
        responseModel: "claude-opus-5",
      },
    },
  ])("keeps readable Claude thinking when moving onto Fable 5.1", ({ source }) => {
    const result = transformTransportMessages(
      [
        {
          role: "assistant",
          provider: source.provider,
          api: "anthropic-messages",
          model: source.model,
          responseModel: source.responseModel,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "earlier reasoning",
              thinkingSignature: "sig_readable",
            },
            { type: "text", text: "visible answer" },
          ],
        },
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
      { role: "user", content: "continue", timestamp: Date.now() },
    ] as unknown as Context["messages"];
    const objectResult = transformTransportMessages(
      objectContentMessages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );
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
      { role: "user", content: "continue", timestamp: Date.now() },
    ] as unknown as Context["messages"];
    const nullResult = transformTransportMessages(
      nullContentMessages,
      makeModel("openai-responses", "openai", "gpt-5.4"),
    );
    expect(nullResult[0]).toMatchObject({ role: "assistant", content: [] });
    expect(nullResult[1]).toMatchObject({ role: "user" });
  });

  describe.each(["error"] as const)("%s replay without visible output", (stopReason) => {
    it.each([
      {
        name: "the no-content placeholder with hidden reasoning",
        content: [
          { type: "text", text: NO_CONTENT_PLACEHOLDER },
          { type: "thinking", thinking: "hidden partial reasoning" },
        ],
      },
    ] satisfies Array<{
      name: string;
      content: Extract<Context["messages"][number], { role: "assistant" }>["content"];
    }>)("drops $name across a model change without inventing a visible turn", ({ content }) => {
      const failed = makeAssistantMessageFixture({ model: "source-model", stopReason, content });
      const user: Context["messages"][number] = {
        role: "user",
        content: "what is the weather?",
        timestamp: 3,
      };

      expect(
        transformTransportMessages(
          [failed, user],
          makeModel("openai-responses", "openai", "gpt-5.4"),
        ),
      ).toEqual([user]);
    });
  });

  it("drops max-token reasoning-only transport assistant turns before replay", () => {
    const messages: Context["messages"] = [
      {
        role: "assistant",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        model: "global.anthropic.claude-sonnet-4-6",
        stopReason: "length",
        timestamp: Date.now(),
        content: [
          {
            type: "thinking",
            thinking: "partial hidden reasoning",
            thinkingSignature: "partial-signature",
          },
        ],
      } as Extract<Context["messages"][number], { role: "assistant" }>,
      { role: "user", content: "retry after max token thinking", timestamp: Date.now() },
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
      {
        role: "toolResult",
        toolCallId: "call_repeated",
        toolName: "exec",
        content: [{ type: "text", text: "failed turn output" }],
        isError: true,
        timestamp: Date.now(),
      },
      { role: "user", content: "retry after error", timestamp: Date.now() },
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
