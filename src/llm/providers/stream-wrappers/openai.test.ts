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
  it("resolves dynamic fast mode for each stream call", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    let enabled = true;
    const wrapped = createOpenAIFastModeWrapper(baseStreamFn, () => enabled);

    void wrapped(openaiModel, { messages: [] }, {});
    enabled = false;
    void wrapped(openaiModel, { messages: [] }, {});

    expect(payloads[0]?.service_tier).toBe("priority");
    expect(payloads[1]).not.toHaveProperty("service_tier");
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
    await payloadResult;

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

  it.each(["", "false"])("does not emit dedicated diagnostics for false-like flag %j", (flag) => {
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", flag);
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(
        {
          tools: [
            { type: "function", name: "exec" },
            { type: "function", name: "wait" },
            { type: "file_search" },
          ],
        },
        model,
      );
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });

    void wrapped(codexModel, codeModeContext(), {});

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("filters async replacement payloads when code mode owns the tool surface", async () => {
    let observedOptions: Parameters<StreamFn>[2];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      observedOptions = options;
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
      config: nativeSearchConfig,
    });
    const model = {
      api: "openai-chatgpt-responses",
      provider: "gateway",
      id: "gpt-5.5",
    } as Model<"openai-chatgpt-responses">;

    void wrapped(model, codeModeContext("sessions_yield", "structured_output"), {
      onPayload: async () => ({
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "computer" },
          { type: "function", name: "image" },
          { type: "function", name: "message" },
          { type: "function", name: "sessions_yield" },
          { type: "function", name: "structured_output" },
          {
            type: "function",
            get function(): { name: string } {
              throw new Error("async code mode payload function getter exploded");
            },
          },
          { type: "function", name: "wait" },
          { type: "web_search" },
          { type: "file_search" },
        ],
      }),
    });

    const nextPayload = await observedOptions?.onPayload?.({ tools: [] }, model);
    expect(nextPayload).toEqual({
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "sessions_yield" },
        { type: "function", name: "structured_output" },
        { type: "function", name: "wait" },
        { type: "web_search" },
      ],
    });
    expect(
      (observedOptions as { openclawCodeModeAllowedHostedToolTypes?: Set<string> } | undefined)
        ?.openclawCodeModeAllowedHostedToolTypes,
    ).toEqual(new Set(["web_search"]));
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

  it("does not enable code-mode transport enforcement when config is on but controls are inactive", () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      observedOptions.push(options as Record<string, unknown>);
      const payload: Record<string, unknown> = { model: model.id };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: {
          codeMode: { enabled: true },
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

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBeUndefined();
    expect(payloads[0]).toEqual({ model: "gpt-5.5" });
  });

  it("enforces the code-mode transport surface when the run enables it at agent scope", () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      observedOptions.push(options as Record<string, unknown>);
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "sessions_yield" },
          { type: "function", name: "structured_output" },
          { type: "function", name: "computer" },
          { type: "function", name: "image" },
          { type: "function", name: "message" },
          { type: "function", name: "read" },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      codeModeContext("sessions_yield", "structured_output"),
      {},
    );

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads[0]?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "function", name: "sessions_yield" },
      { type: "function", name: "structured_output" },
    ]);
  });

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "keeps grouped %s when code mode filters the payload",
    (declarationField) => {
      const payloads: Array<Record<string, unknown>> = [];
      const baseStreamFn: StreamFn = (model, context, options) => {
        const payload: Record<string, unknown> = {
          model: model.id,
          tools: [
            {
              [declarationField]: [
                { name: "exec", description: "Run code" },
                { name: "sessions_yield", description: "Yield the current session" },
                { name: "structured_output", description: "Return a structured response" },
                { name: "computer", description: "Control a desktop" },
                { name: "image", description: "Read an image" },
                { name: "message", description: "Deliver the response" },
                { name: "read", description: "Read a file" },
                { name: "wait", description: "Resume code" },
              ],
            },
            { google_search: {} },
          ],
        };
        options?.onPayload?.(payload, model);
        payloads.push(structuredClone(payload));
        return createAssistantMessageEventStream();
      };
      const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
        codeModeToolSurfaceEnabled: true,
      });

      void wrapped(
        {
          api: "google-generative-ai",
          provider: "google",
          id: "gemini-3.1-pro",
        } as never,
        codeModeContext("sessions_yield", "structured_output"),
        {},
      );

      expect(payloads[0]?.tools).toEqual([
        {
          [declarationField]: [
            { name: "exec", description: "Run code" },
            { name: "sessions_yield", description: "Yield the current session" },
            { name: "structured_output", description: "Return a structured response" },
            { name: "wait", description: "Resume code" },
          ],
        },
      ]);
    },
  );

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
          list: [
            {
              id: "main",
              tools: { deny: ["group:web"] },
            },
          ],
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
      "other properties",
      codexModel,
      "high",
      { effort: "none", summary: "auto" },
      { effort: "high", summary: "auto" },
    ],
    [
      "native max",
      { ...openaiModel, id: "gpt-5.6-sol" },
      "max",
      { effort: "xhigh", summary: "auto" },
      { effort: "max", summary: "auto" },
    ],
    [
      "native minimal floor",
      { ...openaiModel, id: "gpt-5.6-luna" },
      "minimal",
      { effort: "minimal", summary: "auto" },
      { effort: "low", summary: "auto" },
    ],
    [
      "earlier model max",
      { ...openaiModel, id: "gpt-5.5" },
      "max",
      { effort: "high" },
      { effort: "xhigh" },
    ],
    [
      "Azure max",
      {
        ...openaiModel,
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.6-sol",
        baseUrl: "https://example.openai.azure.com/openai",
      },
      "max",
      { effort: "high" },
      { effort: "xhigh" },
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

  it.each([
    {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5.5",
    },
    {
      api: "openai-chatgpt-responses",
      provider: "openai",
      id: "gpt-5.5",
    },
  ] as const)("preserves xhigh for $provider/$id", (model) => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "high" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "xhigh");
    void wrapped(model as Model<typeof model.api>, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "xhigh" });
  });

  it.each([
    openaiModel,
    {
      ...openaiModel,
      api: "openai-completions",
      id: "gpt-4o",
      baseUrl: "https://proxy.example.com/v1",
    },
    { ...openaiModel, baseUrl: "https://proxy.example.com/v1" },
  ] as const)("does not inject absent reasoning for $api at $baseUrl", (model) => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    void createOpenAIThinkingLevelWrapper(baseStreamFn, "medium")(model, { messages: [] }, {});
    expect(payloads[0]?.reasoning).toBeUndefined();
  });

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
