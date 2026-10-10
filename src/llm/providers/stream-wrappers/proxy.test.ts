// Proxy stream wrapper tests cover wrapper selection and provider passthrough.
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import { createOpenRouterSystemCacheWrapper, createOpenRouterWrapper } from "./proxy.js";

function runSystemCacheWrapper(model: Partial<Model<"openai-completions">>) {
  const payload = {
    messages: [{ role: "system", content: "system prompt" }],
  };
  const baseStreamFn: StreamFn = (resolvedModel, context, options) => {
    options?.onPayload?.(payload, resolvedModel);
    return createAssistantMessageEventStream();
  };

  const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
  void wrapped(
    {
      api: "openai-completions",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      ...model,
    } as Model<"openai-completions">,
    { messages: [] },
    {},
  );

  return payload;
}

function captureHeaders(
  extraParams?: Record<string, unknown>,
  model: Partial<Model<"openai-completions">> = {},
  headers?: Record<string, string>,
) {
  const calls: Array<{ headers?: Record<string, string> }> = [];
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    calls.push({ headers: options?.headers });
    return createAssistantMessageEventStream();
  };
  void createOpenRouterWrapper(baseStreamFn, undefined, extraParams)(
    {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
      ...model,
    } as Model<"openai-completions">,
    { messages: [] },
    { headers },
  );
  return calls;
}

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls = captureHeaders(undefined, {}, { "X-Custom": "1" });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "X-OpenRouter-Categories": "personal-agent,cli-agent",
          "X-Custom": "1",
        },
      },
    ]);
  });

  it("sends OpenRouter response cache disables for preset opt-outs", () => {
    const calls = captureHeaders(
      { response_cache: false, response_cache_ttl_seconds: 600 },
      { id: "openrouter/@preset/cached-tests" },
    );

    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("false");
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache-TTL");
  });

  it("supports OpenRouter response cache refresh and TTL clamping", () => {
    const calls = captureHeaders({ response_cache_clear: "true", response_cache_ttl: 999999 });

    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("true");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache-Clear"]).toBe("true");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache-TTL"]).toBe("86400");
  });

  it.each([Number.NaN])("omits non-finite response cache TTL %s", (ttl) => {
    const calls = captureHeaders({ responseCache: true, responseCacheTtlSeconds: ttl });

    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("true");
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache-TTL");
  });

  it("does not add OpenRouter response caching headers to custom proxy routes", () => {
    const calls = captureHeaders(
      { responseCache: true },
      { baseUrl: "https://proxy.example.com/v1" },
    );

    expect(calls[0]?.headers).toBeUndefined();
  });

  it("does not inject Anthropic cache_control markers for automatic OpenRouter DeepSeek cache models", () => {
    const payload = runSystemCacheWrapper({
      id: "deepseek/deepseek-v3.2",
    });

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it.each([["none", false]] as const)(
    "composes managed requests with %s retention and string-only=%s",
    (cacheRetention, requiresStringContent) => {
      const model: Model<"openai-completions"> & {
        compat: { requiresStringContent: boolean };
      } = {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        compat: { requiresStringContent },
      };
      let payload: Record<string, unknown> = {};
      const base: StreamFn = (resolvedModel, context, options) => {
        payload = buildOpenAICompletionsParams(resolvedModel, context, {
          cacheRetention: options?.cacheRetention,
        });
        options?.onPayload?.(payload, resolvedModel);
        return createAssistantMessageEventStream();
      };
      for (const stable of ["STABLE", ""]) {
        for (const hasUser of [true, false]) {
          void createOpenRouterSystemCacheWrapper(base, { cacheRetention })(model, {
            systemPrompt: `${stable}${SYSTEM_PROMPT_CACHE_BOUNDARY}VOLATILE`,
            messages: [
              ...(hasUser ? [{ role: "user" as const, content: "Question", timestamp: 1 }] : []),
              {
                role: "user",
                content: "OpenClaw runtime context:\nRuntime",
                timestamp: 2,
                runtimeContext: {},
              },
            ],
          });
          const wire = JSON.stringify(payload);
          expect(wire.match(/"cache_control":/g) ?? []).toHaveLength(0);
          expect(wire).not.toContain('"text":"VOLATILE","cache_control"');
          expect(wire).not.toContain('"text":"Runtime","cache_control"');
          expect(wire).not.toContain('"ttl":"1h"');
        }
      }
    },
  );

  it("preserves native Anthropic Messages payloads", () => {
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4-6",
      name: "Claude",
      baseUrl: "https://openrouter.ai/api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
    const original = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    };
    const payload = structuredClone(original);
    const base: StreamFn = (resolvedModel, _context, options) => {
      options?.onPayload?.(payload, resolvedModel);
      return createAssistantMessageEventStream();
    };
    void createOpenRouterSystemCacheWrapper(base)(
      model,
      { messages: [] },
      { cacheRetention: "long" },
    );
    expect(payload).toEqual(original);
  });
});
