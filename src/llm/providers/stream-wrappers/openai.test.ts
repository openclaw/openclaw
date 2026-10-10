// OpenAI stream wrapper tests cover streamed text, tools, and reasoning fields.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn() }));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAICompletionsToolsCompatWrapper,
  createOpenAIFastModeWrapper,
  resolveOpenAIFastMode,
  createOpenAIThinkingLevelWrapper,
  createCodexNativeWebSearchWrapper,
} from "./openai.js";

function createPayloadCapture(opts?: {
  initialReasoning?: unknown;
  payload?: () => Record<string, unknown>;
}) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (model, context, options) => {
    const payload: Record<string, unknown> = { model: model.id, ...opts?.payload?.() };
    if (opts?.initialReasoning !== undefined) {
      payload.reasoning = structuredClone(opts.initialReasoning);
    }
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  return { baseStreamFn, payloads };
}

const codexModel = {
  api: "openai-chatgpt-responses",
  provider: "openai",
  id: "gpt-5.1-codex",
} as Model<"openai-chatgpt-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.2",
  baseUrl: "https://api.openai.com/v1",
} as Model<"openai-responses">;

const nativeSearchConfig = {
  tools: {
    web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" as const } } },
  },
};

function codeModeContext(...extraNames: string[]) {
  return {
    messages: [],
    tools: ["exec", "wait", ...extraNames].map((name) => ({
      name,
      description: "",
      parameters: {},
    })),
  };
}

afterEach(() => {
  logger.debug.mockReset();
  logger.info.mockReset();
  vi.unstubAllEnvs();
});

describe("createOpenAIFastModeWrapper", () => {
  it.each(["https://proxy.example/v1"])(
    "preserves Ultrafast on the API boundary at %s",
    (baseUrl) => {
      const { baseStreamFn, payloads } = createPayloadCapture();
      const enabled = resolveOpenAIFastMode({ fastMode: "ultrafast" });
      expect(enabled).toBe("ultrafast");
      const wrapped = createOpenAIFastModeWrapper(baseStreamFn, () => enabled);
      void wrapped({ ...openaiModel, baseUrl }, { messages: [] }, {});
      expect(payloads[0]?.service_tier).toBe("ultrafast");
    },
  );

  it("resolves dynamic fast mode for each stream call", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    let enabled: boolean | "ultrafast" = true;
    const wrapped = createOpenAIFastModeWrapper(baseStreamFn, () => enabled);

    void wrapped(openaiModel, { messages: [] }, {});
    enabled = "ultrafast";
    void wrapped(openaiModel, { messages: [] }, {});
    enabled = false;
    void wrapped(openaiModel, { messages: [] }, {});

    expect(payloads[0]?.service_tier).toBe("priority");
    expect(payloads[1]?.service_tier).toBe("ultrafast");
    expect(payloads[2]).not.toHaveProperty("service_tier");
  });
});

describe("createOpenAICompletionsToolsCompatWrapper", () => {
  it("strips tools fields when OpenAI-compatible models disable tool support", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        tools: [{ type: "function", function: { name: "noop" } }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      }),
    });

    const wrapped = createOpenAICompletionsToolsCompatWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "venice",
        id: "chat-only-model",
        baseUrl: "https://example.invalid/v1",
        compat: { supportsTools: false },
      } as unknown as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]).not.toHaveProperty("tools");
    expect(payloads[0]).not.toHaveProperty("tool_choice");
    expect(payloads[0]).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps tools fields for OpenAI-compatible models without an explicit opt-out", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        tools: [{ type: "function", function: { name: "noop" } }],
      }),
    });

    const wrapped = createOpenAICompletionsToolsCompatWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "venice",
        id: "tool-capable-model",
        baseUrl: "https://example.invalid/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]).toHaveProperty("tools");
  });
});

describe("createCodexNativeWebSearchWrapper", () => {
  it("keeps native_active web_search alongside the code mode tool surface", () => {
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "1");
    const secretFixture = `sk-${"fixture".repeat(6)}`;
    let observedOptions: Parameters<StreamFn>[2];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      observedOptions = options;
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "web_search" },
          { type: "function", name: "rogue" },
          { type: "web_search" },
          { type: "file_search" },
          { type: secretFixture },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: {
          codeMode: { enabled: true },
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      codeModeContext(),
      {
        onPayload: (payload) => {
          const payloadObj = payload as { tools?: unknown } | undefined;
          if (payloadObj && Array.isArray(payloadObj.tools)) {
            payloadObj.tools.push({ type: "function", name: "web_search" });
            payloadObj.tools.push({
              type: "function",
              get function(): { name: string } {
                throw new Error("code mode payload function getter exploded");
              },
            });
          }
        },
      },
    );

    expect(payloads[0]?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
    ]);
    expect(
      (observedOptions as { openclawCodeModeAllowedHostedToolTypes?: Set<string> } | undefined)
        ?.openclawCodeModeAllowedHostedToolTypes,
    ).toEqual(new Set(["web_search"]));
    expect(logger.info).toHaveBeenCalledOnce();
    const diagnostic = String(logger.info.mock.calls[0]?.[0]);
    expect(diagnostic).toContain('"removedToolIdentities":["client:rogue"');
    expect(diagnostic).toContain('"hosted:file_search"');
    expect(diagnostic).not.toContain(secretFixture);
  });

  it("emits one complete diagnostic through composed wrappers after async replacement", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "1");
    let payloadResult: unknown;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      payloadResult = options?.onPayload?.(
        {
          tools: [
            { type: "function", name: "exec" },
            { type: "function", name: "wait" },
            { type: "function", name: "computer" },
            { type: "function", name: "image" },
            { type: "file_search" },
          ],
        },
        model,
      );
      return createAssistantMessageEventStream();
    };
    const inner = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });
    const wrapped = createCodexNativeWebSearchWrapper(inner, {
      codeModeToolSurfaceEnabled: true,
    });

    void wrapped(codexModel, codeModeContext(), {
      onPayload: async () => ({
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "browser" },
          { type: "file_search" },
        ],
      }),
    });
    expect(await payloadResult).toEqual({
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "wait" },
      ],
    });

    expect(logger.info).toHaveBeenCalledOnce();
    const diagnostic = JSON.parse(
      String(logger.info.mock.calls[0]?.[0]).slice("code-mode diagnostic ".length),
    ) as {
      boundary?: string;
      removedToolIdentities?: string[];
    };
    expect(diagnostic.boundary).toBe("provider-tool-surface");
    expect(new Set(diagnostic.removedToolIdentities)).toEqual(
      new Set(["client:browser", "client:computer", "client:image", "hosted:file_search"]),
    );
  });

  it("does not authorize hosted search when runtime tool policy denies it in code mode", () => {
    let observedOptions: Parameters<StreamFn>[2];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      observedOptions = options;
      const payload = {
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "web_search" },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
      nativeWebSearchAllowedByToolPolicy: false,
      config: nativeSearchConfig,
    });

    void wrapped(codexModel, codeModeContext(), {});

    expect(payloads[0]?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
    expect(
      (observedOptions as { openclawCodeModeAllowedHostedToolTypes?: Set<string> } | undefined)
        ?.openclawCodeModeAllowedHostedToolTypes,
    ).toEqual(new Set());
  });

  it("does not inject native web_search when agent policy denies web search", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        tools: [{ type: "function", name: "read" }],
      }),
    });
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      agentId: "main",
      config: {
        agents: {
          entries: {
            main: {
              tools: { deny: ["group:web"] },
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.tools).toEqual([{ type: "function", name: "read" }]);
  });

  it("does not inject native web_search when runtime sender policy denies web search", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        tools: [{ type: "function", name: "read" }],
      }),
    });
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      messageProvider: "teams",
      senderId: "alice",
      config: {
        tools: {
          toolsBySender: {
            "channel:msteams:alice": { deny: ["web_search"] },
          },
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.tools).toEqual([{ type: "function", name: "read" }]);
  });
});

describe("createOpenAICompletionsStrictMessageKeysWrapper", () => {
  it("strips message keys to role and content for strict OpenAI-compatible endpoints", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        messages: [
          {
            role: "assistant",
            content: "calling tool",
            name: "agent",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "noop" } }],
            cache_control: { type: "ephemeral" },
          },
          {
            role: "tool",
            content: "tool result",
            tool_call_id: "call_1",
          },
        ],
      }),
    });

    const wrapped = createOpenAICompletionsStrictMessageKeysWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "infomaniak",
        id: "mistral3",
        baseUrl: "https://api.infomaniak.com/1/ai/example/openai",
        compat: { strictMessageKeys: true },
      } as unknown as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      { role: "assistant", content: "calling tool" },
      { role: "tool", content: "tool result" },
    ]);
  });
});

describe("createOpenAIThinkingLevelWrapper", () => {
  it("removes reasoning when thinkingLevel is off", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "medium" },
    });
    void createOpenAIThinkingLevelWrapper(baseStreamFn, "off")(codexModel, { messages: [] }, {});
    expect(payloads[0]).not.toHaveProperty("reasoning");
  });

  it.each([
    ["adaptive", codexModel, "adaptive", { effort: "none" }, { effort: "medium" }],
    ["disabled string", codexModel, "low", "none", { effort: "low" }],
    [
      "native max",
      { ...openaiModel, id: "gpt-5.6-sol" },
      "max",
      { effort: "xhigh", summary: "auto" },
      { effort: "max", summary: "auto" },
    ],
  ] as const)(
    "normalizes %s reasoning",
    (_name, model, thinkingLevel, initialReasoning, expected) => {
      const { baseStreamFn, payloads } = createPayloadCapture({ initialReasoning });
      void createOpenAIThinkingLevelWrapper(baseStreamFn, thinkingLevel)(
        model,
        { messages: [] },
        {},
      );
      expect(payloads[0]?.reasoning).toEqual(expected);
    },
  );

  it("returns underlying streamFn unchanged when thinkingLevel is undefined", () => {
    const { baseStreamFn } = createPayloadCapture();
    expect(createOpenAIThinkingLevelWrapper(baseStreamFn, undefined)).toBe(baseStreamFn);
  });

  it("passes through generic thinking levels on reasoning-capable models", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      const { baseStreamFn, payloads } = createPayloadCapture({
        initialReasoning: { effort: "none" },
      });
      void createOpenAIThinkingLevelWrapper(baseStreamFn, level)(codexModel, { messages: [] }, {});
      expect(payloads[0]?.reasoning).toEqual({ effort: level });
    }
  });

  it("raises minimal reasoning for web_search on loopback Responses routes", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      payload: () => ({
        reasoning: { effort: "minimal", summary: "auto" },
        tools: [{ type: "function", name: "web_search" }],
      }),
    });
    void createOpenAIThinkingLevelWrapper(baseStreamFn, "minimal")(
      { ...openaiModel, id: "gpt-5", baseUrl: "http://127.0.0.1:19191/v1" },
      { messages: [] },
      {},
    );
    expect(payloads[0]?.reasoning).toEqual({ effort: "low", summary: "auto" });
  });
});

describe("createOpenAIAttributionHeadersWrapper", () => {
  it("routes native Codex traffic through the OpenClaw transport so attribution survives OpenClaw defaults", () => {
    let codexCalls = 0;
    let capturedHeaders: Record<string, string> | undefined;
    const codexTransport: StreamFn = (model, context, options) => {
      codexCalls += 1;
      capturedHeaders = options?.headers;
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIAttributionHeadersWrapper(undefined, {
      codexNativeTransportStreamFn: codexTransport,
    });

    void wrapped(
      {
        ...codexModel,
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      },
    );

    expect(codexCalls).toBe(1);
    expect(capturedHeaders?.originator).toBe("openclaw");
    expect(capturedHeaders?.["User-Agent"]).toMatch(/^openclaw\//);
  });

  it("keeps existing wrapped Codex streams so runtime OAuth injection is preserved", () => {
    let upstreamCalls = 0;
    let codexCalls = 0;
    let capturedOptions:
      | {
          apiKey?: string;
          headers?: Record<string, string>;
        }
      | undefined;
    const upstream: StreamFn = (model, context, options) => {
      upstreamCalls += 1;
      capturedOptions = options;
      return createAssistantMessageEventStream();
    };
    const codexTransport: StreamFn = () => {
      codexCalls += 1;
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIAttributionHeadersWrapper(upstream, {
      codexNativeTransportStreamFn: codexTransport,
    });

    void wrapped(
      {
        ...codexModel,
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {
        apiKey: "oauth-bearer-token",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      },
    );

    expect(upstreamCalls).toBe(1);
    expect(codexCalls).toBe(0);
    expect(capturedOptions?.apiKey).toBe("oauth-bearer-token");
    expect(capturedOptions?.headers?.originator).toBe("openclaw");
    expect(capturedOptions?.headers?.["User-Agent"]).toMatch(/^openclaw\//);
  });
});
