import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createRequireRecord, createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { VERSION } from "../version.js";
import {
  buildProviderStreamFamilyHooks,
  composeProviderStreamWrappers,
  createMoonshotThinkingWrapper,
  createPlainTextToolCallCompatWrapper,
  MOONSHOT_THINKING_STREAM_HOOKS,
} from "./provider-stream.js";

type StreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

function requireFn<T extends (...args: never[]) => unknown>(fn: T | null | undefined): T {
  expect(fn).toBeTypeOf("function");
  if (!fn) {
    throw new Error("expected stream function");
  }
  return fn;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

const streamTestModel = makeProviderModelFixture<"openai-completions">({
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  contextWindow: 8_192,
  maxTokens: 1_024,
}) satisfies Model<"openai-completions">;

function streamTestMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: streamTestModel.api,
    provider: streamTestModel.provider,
    model: streamTestModel.id,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

const requirePayload = createRequireRecord("record", "expected-record");

type OpenAIResponsesTestModel = {
  api: "openai-responses" | "openai-chatgpt-responses";
  provider: "openai";
  baseUrl: string;
  id: string;
};

async function captureOpenAIResponsesFamilyPayload(
  model: OpenAIResponsesTestModel,
  extraParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let capturedPayload: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (requestModel, _context, options) => {
    const payload: Record<string, unknown> = { model: requestModel.id };
    options?.onPayload?.(payload as never, requestModel as never);
    capturedPayload = payload;
    return {} as never;
  };
  const hooks = buildProviderStreamFamilyHooks("openai-responses-defaults");
  const streamFn = requireFn(
    requireFn(hooks.wrapStreamFn)({ streamFn: baseStreamFn, extraParams } as never),
  );

  await streamFn(model as never, {} as never, {});
  return requirePayload(capturedPayload);
}

function expectDefaultThinkingBudget(payload: Record<string, unknown>) {
  expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingBudget: -1 } } });
}

it("createMoonshotThinkingWrapper: sanitizes an async caller replacement for K2.7 highspeed", async () => {
  const modelId = "kimi-k2.7-code-highspeed";
  let finalPayload: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = async (model, _context, options) => {
    const payload = { model: model.id };
    const replacement = await options?.onPayload?.(payload, model);
    finalPayload = requireRecord(replacement ?? payload, "final payload");
    return {} as never;
  };
  const wrapped = createMoonshotThinkingWrapper(baseStreamFn, "disabled", "all");

  await wrapped({ api: "openai-completions", id: modelId } as never, {} as never, {
    onPayload: async () => ({
      model: modelId,
      thinking: { type: "disabled" },
      reasoning_effort: "low",
      temperature: 0,
      top_p: 0.5,
      tool_choice: "required",
    }),
  });

  const payload = requirePayload(finalPayload);
  expect(payload).not.toHaveProperty("thinking");
  expect(payload).not.toHaveProperty("reasoning_effort");
  expect(payload).not.toHaveProperty("temperature");
  expect(payload).not.toHaveProperty("top_p");
  expect(payload.tool_choice).toBe("auto");
});

it("composeProviderStreamWrappers: applies wrappers left to right", () => {
  const order: string[] = [];
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    expect(options?.maxRetries).toBe(0);
    order.push("base");
    return {} as never;
  };

  const wrap =
    (label: string) =>
    (streamFn: StreamFn | undefined): StreamFn =>
    (model, context, options) => {
      order.push(`${label}:before`);
      const result = (streamFn ?? baseStreamFn)(model, context, { ...options, maxRetries: 0 });
      order.push(`${label}:after`);
      return result;
    };

  const composed = requireFn(
    composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b")),
  );

  void composed({} as never, {} as never, {});

  expect(order).toEqual(["b:before", "a:before", "base", "a:after", "b:after"]);
});

it.each([
  {
    name: "public OpenAI Responses: selected Fast overrides configured flex",
    model: {
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5.6-luna",
    },
    extraParams: { fastMode: true, serviceTier: "flex" },
  },
  {
    name: "ChatGPT Responses: fast mode defaults to priority",
    model: {
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      id: "gpt-5.6-sol",
    },
    extraParams: { fast_mode: true },
  },
] as const)("$name", async ({ model, extraParams }) => {
  const payload = await captureOpenAIResponsesFamilyPayload(model, extraParams);
  expect(payload.service_tier).toBe("priority");
});

it("buildProviderStreamFamilyHooks: covers the stream family matrix", async () => {
  let capturedPayload: Record<string, unknown> | undefined;
  let capturedModelId: string | undefined;
  let capturedModelReasoning: boolean | undefined;
  let capturedHeaders: NonNullable<Parameters<StreamFn>[2]>["headers"];
  let capturedReasoning: string | undefined;
  let payloadSeed: Record<string, unknown> | undefined;

  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedModelId = model.id;
    capturedModelReasoning = model.reasoning;
    capturedReasoning = options?.reasoning;
    const payload = {
      model: model.id,
      config: { thinkingConfig: { thinkingBudget: -1 } },
      ...payloadSeed,
    } as Record<string, unknown>;
    payloadSeed = undefined;
    options?.onPayload?.(payload as never, model as never);
    capturedPayload = payload;
    capturedHeaders = options?.headers;
    return {} as never;
  };

  const wrap = (
    family:
      | Parameters<typeof buildProviderStreamFamilyHooks>[0]
      | typeof MOONSHOT_THINKING_STREAM_HOOKS,
    context: Partial<ProviderWrapStreamFnContext>,
  ) =>
    requireFn(
      requireFn(
        (typeof family === "string" ? buildProviderStreamFamilyHooks(family) : family).wrapStreamFn,
      )({
        streamFn: baseStreamFn,
        ...context,
      } as ProviderWrapStreamFnContext),
    );
  const capture = async (
    stream: StreamFn,
    model: Record<string, unknown>,
    seed?: Record<string, unknown>,
  ) => {
    payloadSeed = seed;
    await stream(model as never, {} as never, {});
    return requirePayload(capturedPayload);
  };
  const check = async (...args: Parameters<typeof capture>) => {
    const payload = await capture(...args);
    expectDefaultThinkingBudget(payload);
    return payload;
  };
  const noKeys = (payload: Record<string, unknown>, ...keys: string[]) => {
    for (const key of keys) {
      expect(payload).not.toHaveProperty(key);
    }
  };
  const completions = (id: string) => ({ api: "openai-completions", id });

  const google = await capture(wrap("google-thinking", { thinkingLevel: "high" }), {
    api: "google-generative-ai",
    id: "gemini-3.1-pro-preview",
  });
  expect(google).toMatchObject({ config: { thinkingConfig: { thinkingLevel: "HIGH" } } });
  expect(google).not.toHaveProperty("config.thinkingConfig.thinkingBudget");

  await capture(wrap("minimax-fast-mode", { extraParams: { fastMode: true } }), {
    api: "anthropic-messages",
    provider: "minimax",
    id: "MiniMax-M2.7",
  });
  expect(capturedModelId).toBe("MiniMax-M2.7-highspeed");

  const kilo = (modelId: string) => wrap("kilocode-thinking", { thinkingLevel: "high", modelId });
  expect(
    await check(kilo("openai/gpt-5.4"), { provider: "kilocode", id: "openai/gpt-5.4" }),
  ).toMatchObject({ reasoning: { effort: "high" } });
  expect(
    await check(kilo("kilo-auto/balanced"), { provider: "kilocode", id: "kilo-auto/balanced" }),
  ).not.toHaveProperty("reasoning");

  const moonshot = (context: Partial<ProviderWrapStreamFnContext>) =>
    wrap(MOONSHOT_THINKING_STREAM_HOOKS, context);
  expect(await check(moonshot({ thinkingLevel: "off" }), completions("kimi-k2.5"))).toMatchObject({
    thinking: { type: "disabled" },
  });
  const keepStream = moonshot({
    thinkingLevel: "low",
    extraParams: { thinking: { type: "enabled", keep: "all" } },
  });
  expect(await check(keepStream, completions("kimi-k2.6"))).toMatchObject({
    thinking: { type: "enabled", keep: "all" },
  });
  const stripped = await check(keepStream, completions("kimi-k2.5"));
  expect(stripped).toMatchObject({ thinking: { type: "enabled" } });
  expect(stripped).not.toHaveProperty("thinking.keep");

  const toolChoice = { type: "tool", name: "read" };
  const forced = await check(keepStream, completions("kimi-k2.6"), { tool_choice: toolChoice });
  expect(forced.tool_choice).toEqual({ type: "tool", name: "read" });
  expect(forced).toMatchObject({ thinking: { type: "disabled" } });
  expect(forced).not.toHaveProperty("thinking.keep");

  const k27 = await check(
    keepStream,
    { ...completions("kimi-k2.7-code"), reasoning: false },
    {
      tool_choice: toolChoice,
      temperature: 0,
      top_p: 0.5,
      n: 2,
      presence_penalty: 1,
      frequency_penalty: 1,
      reasoning_effort: "low",
    },
  );
  noKeys(
    k27,
    "thinking",
    "reasoning_effort",
    "temperature",
    "top_p",
    "n",
    "presence_penalty",
    "frequency_penalty",
  );
  expect(k27.tool_choice).toBe("auto");
  expect(capturedReasoning).toBe("low");
  expect(capturedModelReasoning).toBe(true);

  const k3 = await check(
    keepStream,
    { ...completions("kimi-k3"), provider: "moonshot", reasoning: false },
    {
      thinking: { type: "disabled" },
      tool_choice: toolChoice,
      temperature: 0,
      reasoning_effort: "low",
    },
  );
  noKeys(k3, "thinking", "temperature");
  expect(k3.reasoning_effort).toBe("max");
  expect(k3.tool_choice).toEqual({ type: "tool", name: "read" });
  expect(capturedReasoning).toBe("max");
  expect(capturedModelReasoning).toBe(true);

  const openai = await check(
    wrap("openai-responses-defaults", {
      thinkingLevel: "max",
      extraParams: { serviceTier: "flex" },
      config: {},
      agentDir: "/tmp/provider-stream-test",
    }),
    {
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5.6-sol",
      thinkingLevelMap: { max: "max" },
    },
    { reasoning: { effort: "medium", summary: "auto" } },
  );
  expect(openai.reasoning).toEqual({ effort: "max", summary: "auto" });
  expect(openai.service_tier).toBe("flex");
  expect(capturedHeaders).toEqual({
    "User-Agent": "openclaw/" + VERSION,
    originator: "openclaw",
    version: VERSION,
  });

  const router = (modelId: string) =>
    wrap("openrouter-thinking", { thinkingLevel: "high", modelId });
  expect(
    await check(router("openai/gpt-5.4"), { provider: "openrouter", id: "openai/gpt-5.4" }),
  ).toMatchObject({ reasoning: { effort: "high" } });
  const noEffort = {
    ...streamTestModel,
    provider: "openrouter",
    id: "example/no-effort-selector",
    compat: { supportsReasoningEffort: false },
  };
  expect(await check(router(noEffort.id), noEffort)).not.toHaveProperty("reasoning");

  const toolStream = (extraParams: Record<string, unknown>) =>
    wrap("tool-stream-default-on", { extraParams });
  expect((await check(toolStream({}), { id: "glm-4.7" })).tool_stream).toBe(true);
  expect(await check(toolStream({ tool_stream: false }), { id: "glm-4.7" })).not.toHaveProperty(
    "tool_stream",
  );
});

it("createPlainTextToolCallCompatWrapper: streams normal prose that starts with a Harmony channel word", async () => {
  let pushSourceEvent: ((event: never) => void) | undefined;
  const baseStreamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    pushSourceEvent = (event) => stream.push(event);
    return stream;
  };
  const wrapped = requireFn(createPlainTextToolCallCompatWrapper(baseStreamFn));
  const output = wrapped(
    streamTestModel,
    { tools: [{ name: "read" }] } as never,
    {},
  ) as AsyncIterable<unknown>;
  const iterator = output[Symbol.asyncIterator]();
  const first = iterator.next();

  pushSourceEvent?.({
    type: "text_delta",
    contentIndex: 0,
    delta: "final answer starts here",
  } as never);

  const firstResult = await Promise.race([
    first,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 20);
    }),
  ]);
  expect(firstResult).not.toBe("timeout");
  expect(firstResult).toMatchObject({
    done: false,
    value: { type: "text_delta", delta: "final answer starts here" },
  });
  expect(firstResult).not.toHaveProperty("value.partial");

  pushSourceEvent?.({
    type: "done",
    reason: "stop",
    message: streamTestMessage("final answer starts here"),
  } as never);
  await iterator.next();
});
