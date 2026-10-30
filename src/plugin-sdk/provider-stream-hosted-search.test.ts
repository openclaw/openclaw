import type { OpenAIResponsesOptions } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createOpenAIHostedWebSearchWrapper } from "./provider-stream-shared.js";

const model = makeProviderModelFixture<"openai-responses">({
  api: "openai-responses",
  provider: "openai",
  id: "fixture",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  contextWindow: 8192,
  maxTokens: 1024,
}) satisfies Model<"openai-responses">;

it("preserves native OpenAI hosted-search payload bytes and async replacement-hook semantics", async () => {
  let wire = "";
  const base: StreamFn = async (selected, _context, options) => {
    const payload = {
      model: selected.id,
      tools: [
        { type: "function", name: "read" },
        { type: "function", name: "web_search" },
      ],
      reasoning: { effort: "minimal" },
      stream: true,
    };
    wire = JSON.stringify((await options?.onPayload?.(payload, selected)) ?? payload);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const allowed = new Set<string>();
  const wrapped = createOpenAIHostedWebSearchWrapper(base, () => true);
  const options: Parameters<StreamFn>[2] &
    Pick<OpenAIResponsesOptions, "openclawCodeModeAllowedHostedToolTypes"> = {
    openclawCodeModeAllowedHostedToolTypes: allowed,
  };
  await wrapped(model, { messages: [] }, options);
  const nativeWire =
    '{"model":"fixture","tools":[{"type":"function","name":"read"},{"type":"web_search"}],"reasoning":{"effort":"low"},"stream":true}';
  expect(wire).toBe(nativeWire);
  expect(allowed).toEqual(new Set(["web_search"]));
  await wrapped(
    model,
    { messages: [] },
    {
      onPayload: async () => ({
        tools: [{ type: "function", name: "web_search" }],
        reasoning: { effort: "minimal" },
      }),
    },
  );
  expect(wire).toBe('{"tools":[{"type":"web_search"}],"reasoning":{"effort":"low"}}');
  await wrapped(
    model,
    { messages: [] },
    {
      onPayload: (payload) => {
        (payload as Record<string, unknown>).reasoning = { effort: "high" };
      },
    },
  );
  expect(JSON.parse(wire).reasoning).toEqual({ effort: "high" });
});
