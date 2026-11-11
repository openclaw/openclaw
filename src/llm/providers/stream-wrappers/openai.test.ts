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
  createOpenAIResponsesContextManagementWrapper,
  resolveOpenAIFastMode,
  createOpenAIThinkingLevelWrapper,
  createCodexNativeWebSearchWrapper,
} from "./openai.js";

function createPayloadCapture(opts?: {
  initialReasoning?: unknown;
  payload?: () => Record<string, unknown>;
}) {
  const payloads: Array<Record<string, unknown>> = [];
  const observedOptions: Array<
    NonNullable<Parameters<StreamFn>[2]> & {
      openclawCodeModeToolSurface?: boolean;
      openclawCodeModeAllowedHostedToolTypes?: Set<string>;
    }
  > = [];
  const baseStreamFn: StreamFn = (model, context, options) => {
    observedOptions.push(options ?? {});
    const payload: Record<string, unknown> = {
      model: model.id,
      ...opts?.payload?.(),
    };
    if (opts?.initialReasoning !== undefined) {
      payload.reasoning = structuredClone(opts.initialReasoning);
    }
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  const run = (
    wrapped: StreamFn,
    model: Parameters<StreamFn>[0] = gatewayModel,
    context: Parameters<StreamFn>[1] = { messages: [] },
    options: Parameters<StreamFn>[2] = {},
  ) => {
    void wrapped(model, context, options);
  };
  return { baseStreamFn, payloads, observedOptions, run };
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
const gatewayModel = { ...codexModel, provider: "gateway", id: "gpt-5.5" };
const functionTools = (...names: string[]) => names.map((name) => ({ type: "function", name }));
const declarations = (...names: string[]) => names.map((name) => ({ name, description: name }));

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

it.each([
  { payloadTier: undefined, fastMode: "ultrafast" as const, expected: 260_000 },
  { payloadTier: "priority", fastMode: "ultrafast" as const, expected: 700_000 },
  { payloadTier: "ultrafast", fastMode: false, expected: 260_000 },
])("uses the actual request tier $payloadTier/$fastMode", ({ payloadTier, fastMode, expected }) => {
  const { baseStreamFn, payloads } = createPayloadCapture({
    payload: () => (payloadTier === undefined ? {} : { service_tier: payloadTier }),
  });
  const wrapped = createOpenAIResponsesContextManagementWrapper(
    createOpenAIFastModeWrapper(baseStreamFn, fastMode),
    { fastMode, responsesCompactThreshold: 700_000 },
  );
  void wrapped(
    { ...openaiModel, contextWindow: 1_050_000, contextTokens: 922_000 },
    { messages: [] },
    {},
  );
  expect(payloads[0]?.context_management).toEqual([
    { type: "compaction", compact_threshold: expected },
  ]);
});
describe("createOpenAIFastModeWrapper", () => {
  it.each(["https://api.openai.com/v1", "https://proxy.example/v1"])(
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

it.each([false, undefined])("respects explicit tool opt-out %s", (supportsTools) => {
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
      id: "test-model",
      baseUrl: "https://example.invalid/v1",
      ...(supportsTools === false ? { compat: { supportsTools } } : {}),
    } as unknown as Model<"openai-completions">,
    { messages: [] },
    {},
  );

  if (supportsTools === false) {
    expect(payloads[0]).not.toHaveProperty("tools");
    expect(payloads[0]).not.toHaveProperty("tool_choice");
    expect(payloads[0]).not.toHaveProperty("parallel_tool_calls");
  } else {
    expect(payloads[0]).toHaveProperty("tools");
  }
});
describe("createCodexNativeWebSearchWrapper", () => {
  it("keeps native_active web_search alongside the code mode tool surface", () => {
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "1");
    const secretFixture = `sk-${"fixture".repeat(6)}`;
    const { baseStreamFn, payloads, observedOptions, run } = createPayloadCapture({
      payload: () => ({
        tools: [
          ...functionTools("exec", "wait", "web_search", "rogue"),
          { type: "web_search" },
          { type: "file_search" },
          { type: secretFixture },
        ],
      }),
    });
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: { ...nativeSearchConfig.tools, codeMode: { enabled: true } },
      },
    });

    run(wrapped, gatewayModel, codeModeContext(), {
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
    });

    expect(payloads[0]?.tools).toEqual([...functionTools("exec", "wait"), { type: "web_search" }]);
    expect(observedOptions.at(-1)?.openclawCodeModeAllowedHostedToolTypes).toEqual(
      new Set(["web_search"]),
    );
    expect(logger.info).toHaveBeenCalledOnce();
    const diagnostic = String(logger.info.mock.calls[0]?.[0]);
    expect(diagnostic).toContain('"removedToolIdentities":["client:rogue"');
    expect(diagnostic).toContain('"hosted:file_search"');
    // The logger receives raw metadata; its console/export boundaries own redaction.
    expect(diagnostic).toContain(`"hosted:${secretFixture}"`);
  });

  it("emits one complete diagnostic through composed wrappers after async replacement", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", "1");
    let payloadResult: unknown;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      payloadResult = options?.onPayload?.(
        {
          tools: [...functionTools("exec", "wait", "computer", "image"), { type: "file_search" }],
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
        tools: [...functionTools("exec", "wait", "browser"), { type: "file_search" }],
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
    const { baseStreamFn } = createPayloadCapture({
      payload: () => ({ tools: [...functionTools("exec", "wait"), { type: "file_search" }] }),
    });
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
    const model = gatewayModel;

    void wrapped(model, codeModeContext("sessions_yield", "structured_output"), {
      onPayload: async () => ({
        tools: [
          ...functionTools(
            "exec",
            "computer",
            "image",
            "message",
            "sessions_yield",
            "structured_output",
          ),
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
        ...functionTools("exec", "sessions_yield", "structured_output", "wait"),
        { type: "web_search" },
      ],
    });
    expect(
      (observedOptions as { openclawCodeModeAllowedHostedToolTypes?: Set<string> } | undefined)
        ?.openclawCodeModeAllowedHostedToolTypes,
    ).toEqual(new Set(["web_search"]));
  });

  it("does not authorize hosted search when runtime tool policy denies it in code mode", () => {
    const { baseStreamFn, payloads, observedOptions } = createPayloadCapture({
      payload: () => ({
        tools: [...functionTools("exec", "wait"), { type: "web_search" }],
      }),
    });
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
      nativeWebSearchAllowedByToolPolicy: false,
      config: nativeSearchConfig,
    });

    void wrapped(codexModel, codeModeContext(), {});

    expect(payloads[0]?.tools).toEqual(functionTools("exec", "wait"));
    expect(observedOptions.at(-1)?.openclawCodeModeAllowedHostedToolTypes).toEqual(new Set());
  });

  it("does not enable code-mode transport enforcement when config is on but controls are inactive", () => {
    const { baseStreamFn, payloads, observedOptions, run } = createPayloadCapture();
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: {
          codeMode: { enabled: true },
        },
      },
    });

    run(wrapped);

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBeUndefined();
    expect(payloads[0]).toEqual({ model: "gpt-5.5" });
  });

  it("enforces the code-mode transport surface when the run enables it at agent scope", () => {
    const { baseStreamFn, payloads, observedOptions, run } = createPayloadCapture({
      payload: () => ({
        tools: functionTools(
          "exec",
          "wait",
          "sessions_yield",
          "structured_output",
          "computer",
          "image",
          "message",
          "read",
        ),
      }),
    });
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });

    run(wrapped, gatewayModel, codeModeContext("sessions_yield", "structured_output"));

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads[0]?.tools).toEqual(
      functionTools("exec", "wait", "sessions_yield", "structured_output"),
    );
  });

  it.each(["functionDeclarations", "function_declarations"] as const)(
    "keeps grouped %s when code mode filters the payload",
    (declarationField) => {
      const { baseStreamFn, payloads } = createPayloadCapture({
        payload: () => ({
          tools: [
            {
              [declarationField]: declarations(
                "exec",
                "sessions_yield",
                "structured_output",
                "computer",
                "image",
                "message",
                "read",
                "wait",
              ),
            },
            { google_search: {} },
          ],
        }),
      });
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
          [declarationField]: declarations("exec", "sessions_yield", "structured_output", "wait"),
        },
      ]);
    },
  );

  it.each([
    {
      name: "agent policy",
      agentId: "main",
      config: {
        agents: {
          entries: {
            main: {
              tools: { deny: ["group:web"] },
            },
          },
        },
        ...nativeSearchConfig,
      },
    },
    {
      name: "runtime sender policy",
      messageProvider: "teams",
      senderId: "alice",
      config: {
        tools: {
          ...nativeSearchConfig.tools,
          toolsBySender: {
            "channel:msteams:alice": { deny: ["web_search"] },
          },
        },
      },
    },
  ])("does not inject native web_search when $name denies it", (params) => {
    const { baseStreamFn, payloads, run } = createPayloadCapture({
      payload: () => ({ tools: functionTools("read") }),
    });
    run(createCodexNativeWebSearchWrapper(baseStreamFn, params));
    expect(payloads[0]?.tools).toEqual([{ type: "function", name: "read" }]);
  });
});

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
describe("createOpenAIThinkingLevelWrapper", () => {
  const withSummary = (effort: string) => ({ effort, summary: "auto" });
  const sol = { ...openaiModel, id: "gpt-5.6-sol" };
  const luna = { ...openaiModel, id: "gpt-5.6-luna" };
  const earlier = { ...openaiModel, id: "gpt-5.5" };
  const azure: Model<"azure-openai-responses"> = {
    ...sol,
    api: "azure-openai-responses",
    provider: "azure-openai-responses",
    baseUrl: "https://example.openai.azure.com/openai",
  };
  function captureReasoning(
    level: Parameters<typeof createOpenAIThinkingLevelWrapper>[1],
    initialReasoning?: unknown,
    model: Parameters<StreamFn>[0] = codexModel,
  ) {
    const { baseStreamFn, payloads, run } = createPayloadCapture({ initialReasoning });
    run(createOpenAIThinkingLevelWrapper(baseStreamFn, level), model);
    return payloads[0];
  }

  it("removes reasoning when thinkingLevel is off", () => {
    expect(captureReasoning("off", { effort: "medium" })).not.toHaveProperty("reasoning");
  });

  it.each([
    ["adaptive", codexModel, "adaptive", { effort: "none" }, { effort: "medium" }],
    ["disabled string", codexModel, "low", "none", { effort: "low" }],
    ["other properties", codexModel, "high", withSummary("none"), withSummary("high")],
    ["native max", sol, "max", withSummary("xhigh"), withSummary("max")],
    ["native minimal floor", luna, "minimal", withSummary("minimal"), withSummary("low")],
    ["earlier model max", earlier, "max", { effort: "high" }, { effort: "xhigh" }],
    ["Azure max", azure, "max", { effort: "high" }, { effort: "xhigh" }],
  ] as const)(
    "normalizes %s reasoning",
    (_name, model, thinkingLevel, initialReasoning, expected) => {
      expect(captureReasoning(thinkingLevel, initialReasoning, model)?.reasoning).toEqual(expected);
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
    expect(
      captureReasoning("xhigh", { effort: "high" }, model as Model<typeof model.api>)?.reasoning,
    ).toEqual({ effort: "xhigh" });
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
    expect(captureReasoning("medium", undefined, model)?.reasoning).toBeUndefined();
  });

  it("returns underlying streamFn unchanged when thinkingLevel is undefined", () => {
    const { baseStreamFn } = createPayloadCapture();
    expect(createOpenAIThinkingLevelWrapper(baseStreamFn, undefined)).toBe(baseStreamFn);
  });

  it("passes through generic thinking levels on reasoning-capable models", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(captureReasoning(level, { effort: "none" })?.reasoning).toEqual({ effort: level });
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
  const model = { ...codexModel, baseUrl: "https://chatgpt.com/backend-api" };
  const headers = { originator: "openclaw", "User-Agent": "openclaw" };
  it("routes native Codex traffic through the OpenClaw transport so attribution survives OpenClaw defaults", () => {
    const { baseStreamFn, observedOptions } = createPayloadCapture();
    const wrapped = createOpenAIAttributionHeadersWrapper(undefined, {
      codexNativeTransportStreamFn: baseStreamFn,
    });
    void wrapped(model, { messages: [] }, { headers });
    expect(observedOptions).toHaveLength(1);
    expect(observedOptions[0]?.headers).toMatchObject({
      originator: "openclaw",
      "User-Agent": expect.stringMatching(/^openclaw\//),
    });
  });

  it("keeps existing wrapped Codex streams so runtime OAuth injection is preserved", () => {
    const { baseStreamFn, observedOptions } = createPayloadCapture();
    const codexTransport = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const wrapped = createOpenAIAttributionHeadersWrapper(baseStreamFn, {
      codexNativeTransportStreamFn: codexTransport,
    });

    void wrapped(model, { messages: [] }, { apiKey: "oauth-bearer-token", headers });
    expect(observedOptions).toHaveLength(1);
    expect(codexTransport).not.toHaveBeenCalled();
    expect(observedOptions[0]).toMatchObject({
      apiKey: "oauth-bearer-token",
      headers: { originator: "openclaw", "User-Agent": expect.stringMatching(/^openclaw\//) },
    });
  });
});
