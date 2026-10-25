import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import type { Api, Context } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { transformTransportMessages } from "./transport-message-transform.js";

const EXPECTED_FAILURE_MARKER =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";

const makeModel = (api: Api, provider: string, id: string) =>
  makeProviderModelFixture({ api, provider, id, baseUrl: "https://example.test" });

type ToolResultMessage = Extract<Context["messages"][number], { role: "toolResult" }>;
type AssistantMessage = Extract<Context["messages"][number], { role: "assistant" }>;
const userMessage = (content: string, timestamp = Date.now()) => ({
  role: "user" as const,
  content,
  timestamp,
});
const text = (value: string) => ({ type: "text" as const, text: value });
const openai = makeModel("openai-responses", "openai", "gpt-5.4");
const anthropic = makeModel("anthropic-messages", "anthropic", "claude-opus-4-6");
const replay = (messages: Context["messages"], model = openai) =>
  transformTransportMessages(messages, model);
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
const thinking = { type: "thinking" as const, thinking: "reasoning", thinkingSignature: "sig" };
const assistant = (overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">) =>
  makeAgentAssistantMessage({ model: "gpt-5.4", ...overrides });

function assistantToolCall(
  id: string,
  name = "read",
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return assistant({
    stopReason,
    content: [{ type: "toolCall", id, name, arguments: {} }],
  });
}

it("compacts sparse history without changing the source or sharing assistant arrays", () => {
  const api = "openai-completions";
  const completion = (
    content: AssistantMessage["content"],
    stopReason?: AssistantMessage["stopReason"],
  ) => makeAssistantMessageFixture({ api, content, ...(stopReason ? { stopReason } : {}) });
  const hidden = completion([{ type: "thinking", thinking: "unfinished reasoning" }]);
  const failed = completion([text("unfinished answer")]);
  const retained = completion([text("completed answer")], "stop");
  const user = userMessage("continue", 1);
  const messages: Context["messages"] = [];
  messages[1] = hidden;
  messages[3] = failed;
  messages[4] = retained;
  messages[6] = user;
  messages.length = 8;
  const original = structuredClone(messages);

  const result = replay(messages, makeModel(api, "openai", "test-model"));

  expect(result).toStrictEqual([
    { ...failed, content: [text(EXPECTED_FAILURE_MARKER)] },
    retained,
    user,
  ]);
  const replayedAssistant = result[1];
  if (replayedAssistant?.role !== "assistant") {
    throw new Error("expected the completed assistant turn");
  }
  replayedAssistant.stopReason = "length";
  replayedAssistant.content.push(text("replay-only addition"));
  result.pop();
  expect(messages).toStrictEqual(original);
});

it("preserves unframed tool results only for a selected compaction replay window", () => {
  const messages = [
    assistantToolCall("call_early"),
    userMessage("continue"),
    assistantToolCall("call_after"),
    toolResult("call_early", "displaced retained result"),
    toolResult("call_before", "real result after compaction"),
  ] as Context["messages"];

  const normal = replay(messages);
  const compactionReplay = transformTransportMessages(messages, openai, undefined, {
    preserveUnframedToolResults: true,
  });

  const expected = [
    { toolCallId: "call_early", content: [text("displaced retained result")] },
    { toolCallId: "call_after", content: [text("aborted")] },
  ];
  expect(normal.filter((message) => message.role === "toolResult")).toMatchObject(expected);
  expect(compactionReplay.filter((message) => message.role === "toolResult")).toMatchObject([
    ...expected,
    { toolCallId: "call_before", content: [text("real result after compaction")] },
  ]);
});

// Live-verified 2026-09-02: equivalent response-model bindings retain usable reasoning.
it.each([
  [{ provider: "anthropic", model: "claude-sonnet-4-6" }, "claude-fable-5", false],
  [
    { provider: "microsoft-foundry", model: "prod-primary", responseModel: "claude-opus-5" },
    "claude-fable-5-1",
    true,
  ],
] as const)("applies thinking binding from %j to %s", (source, target, keepThinking) => {
  const result = replay(
    [
      assistant({
        api: "anthropic-messages",
        ...source,
        stopReason: "stop",
        content: [thinking, text("visible answer")],
      }),
    ],
    makeModel("anthropic-messages", "anthropic", target),
  );

  expect(result[0]).toMatchObject({
    role: "assistant",
    content: [...(keepThinking ? [thinking] : []), text("visible answer")],
  });
});

it.each([
  [text("legacy object"), [text("legacy object")]],
  [null, []],
] as const)("normalizes %j assistant content before transport conversion", (content, expected) => {
  const messages = [
    {
      ...assistantToolCall("call_object"),
      stopReason: "stop",
      content,
    },
    userMessage("continue"),
  ] as unknown as Context["messages"];
  const result = replay(messages);
  expect(result[0]).toMatchObject({ role: "assistant", content: expected });
  expect(result[1]).toMatchObject({ role: "user" });
});

it("drops max-token reasoning-only transport assistant turns before replay", () => {
  const model = makeModel("bedrock-converse-stream", "amazon-bedrock", "claude-sonnet-4-6");
  const user = userMessage("retry after max token thinking");
  expect(
    replay(
      [
        assistant({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "length",
          content: [thinking],
        }),
        user,
      ],
      model,
    ),
  ).toEqual([user]);
});

it("does not reassign a dropped errored turn's repeated-id result to an older turn", () => {
  const messages: Context["messages"] = [
    assistantToolCall("call_repeated"),
    assistantToolCall("call_repeated", "exec", "error"),
    toolResult("call_repeated", "failed turn output", "exec", true),
    userMessage("retry after error"),
  ];

  const result = replay(messages, anthropic);

  expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
  expect(result[1]).toMatchObject({
    role: "toolResult",
    toolCallId: "call_repeated",
    isError: true,
    content: [text(DEFAULT_MISSING_TOOL_RESULT_TEXT)],
  });
  expect(JSON.stringify(result)).not.toContain("failed turn output");
});
