import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { createMinimaxFastModeWrapper, createMinimaxThinkingDisabledWrapper } from "./minimax.js";

const minimaxModel = {
  api: "anthropic-messages",
  provider: "minimax",
  id: "MiniMax-M2.7",
} as Model<"anthropic-messages">;
const m3 = { ...minimaxModel, id: "MiniMax-M3" };
const enabledThinking = { type: "enabled", budget_tokens: 1024 };
const disabledThinking = { type: "disabled" };

function captureThinkingPayload(
  model: Model = minimaxModel,
  payload: Record<string, unknown> = {},
  thinkingLevel?: ThinkLevel,
  options: Parameters<StreamFn>[2] = {},
) {
  void createMinimaxThinkingDisabledWrapper((streamModel, _context, streamOptions) => {
    streamOptions?.onPayload?.(payload, streamModel);
    return createAssistantMessageEventStream();
  }, thinkingLevel)(model, { messages: [] }, options);
  return payload;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it.each([
    ["minimax", "anthropic-messages", "MiniMax-M2.7", { type: "disabled" }],
    ["minimax-portal", "anthropic-messages", "MiniMax-M2.7", { type: "disabled" }],
    ["anthropic", "anthropic-messages", "claude-sonnet-4-6", undefined],
    ["minimax", "openai-completions", "MiniMax-M2.7", undefined],
    ["minimax", "anthropic-messages", "MiniMax-M3", undefined],
    ["minimax-portal", "anthropic-messages", "MiniMax-M3", undefined],
  ] as const)("sets default thinking for %s/%s/%s", (provider, api, id, expected) => {
    expect(captureThinkingPayload({ ...minimaxModel, provider, api, id }).thinking).toEqual(
      expected,
    );
  });

  it.each([
    ["removes implicit disabled thinking", undefined, disabledThinking, undefined],
    ["preserves explicit off thinking", "off", disabledThinking, disabledThinking],
    ["rewrites budget thinking to adaptive", "adaptive", enabledThinking, { type: "adaptive" }],
  ] as const)("%s for MiniMax-M3", (_name, thinkingLevel, thinking, expected) => {
    expect(captureThinkingPayload(m3, { thinking }, thinkingLevel).thinking).toEqual(expected);
  });

  it.each([
    [500, 500],
    [1.5, 1],
    [0.5, 0],
  ])("restores MiniMax-M3 maxTokens %s when rewriting budget thinking", (maxTokens, expected) => {
    expect(
      captureThinkingPayload(
        m3,
        { max_tokens: 8692, thinking: { type: "enabled", budget_tokens: 8192 } },
        "adaptive",
        { maxTokens },
      ),
    ).toMatchObject({ max_tokens: expected, thinking: { type: "adaptive" } });
  });

  it("preserves explicit enabled thinking for MiniMax-M3", () => {
    const capturedPayload = captureThinkingPayload(m3, { thinking: disabledThinking }, undefined, {
      onPayload: (payload) => {
        (payload as Record<string, unknown>).thinking = enabledThinking;
      },
    });
    expect(capturedPayload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("preserves an already-set thinking value", () => {
    expect(captureThinkingPayload(minimaxModel, { thinking: enabledThinking }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });
});

it.each([true, false])("selects highspeed with a dynamic control=%s", (dynamic) => {
  const baseStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
  let enabled = true;
  const wrapped = createMinimaxFastModeWrapper(baseStreamFn, dynamic ? () => enabled : true);
  void wrapped(minimaxModel, { messages: [] }, {});
  enabled = false;
  void wrapped(minimaxModel, { messages: [] }, {});
  const ids = baseStreamFn.mock.calls.map(([model]) => model.id);
  expect(ids).toEqual([
    "MiniMax-M2.7-highspeed",
    dynamic ? "MiniMax-M2.7" : "MiniMax-M2.7-highspeed",
  ]);
});
