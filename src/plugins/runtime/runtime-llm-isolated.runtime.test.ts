// Isolated runtime.llm.complete tests cover zero-tool dispatch and policy enforcement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreparedModelRuntimeInitialRunAdmissionError,
  PreparedModelRuntimeOwnerNotPublishedError,
} from "../../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginEntryConfig } from "../../config/types.plugins.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import type { Model } from "../../llm/types.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { LlmIsolatedAgentRuntimeCompleteParams } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  runIsolatedCompletion: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: hoisted.runIsolatedCompletion,
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function configWithPluginPolicy(pluginId: string, llm: PluginEntryConfig["llm"]): OpenClawConfig {
  return { ...cfg, plugins: { entries: { [pluginId]: { llm } } } };
}

function isolatedRequest(
  overrides: Partial<LlmIsolatedAgentRuntimeCompleteParams> = {},
): LlmIsolatedAgentRuntimeCompleteParams {
  return {
    messages: [{ role: "user", content: "Return JSON" }],
    execution: { mode: "isolated-agent-runtime" },
    ...overrides,
  };
}

function authorizedLlm() {
  return createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
}

function primeCompletionMocks() {
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      const slash = params.modelRef?.indexOf("/") ?? -1;
      return {
        provider: slash > 0 ? params.modelRef?.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef?.slice(slash + 1) : (params.modelRef ?? "gpt-5.5"),
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.runIsolatedCompletion.mockResolvedValue({
    text: "isolated",
    provider: "openai",
    model: "gpt-5.5",
    owner: { kind: "harness", id: "openclaw" },
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
    },
  });
}

function expectSingleCallFirstArg(mock: { mock: { calls: unknown[][] } }, expected: object) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
}

function outputSchemaWithSerializedBytes(bytes: number) {
  const schema = { type: "string", description: "" };
  const fixedBytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  return { ...schema, description: "x".repeat(bytes - fixedBytes) };
}

describe("runtime.llm.complete isolated agent runtime", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.runIsolatedCompletion.mockReset();
    primeCompletionMocks();
  });

  it("routes authorized isolated completion through the configured agent runtime", async () => {
    const outputSchema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    };
    const usageEvents: Array<{
      hostPluginId?: string;
      internal?: boolean;
      trusted: boolean;
      usage: unknown;
    }> = [];
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          usageEvents.push({
            hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
            internal: metadata.internal,
            trusted: metadata.trusted,
            usage: event.usage,
          });
        }
      }),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.5",
      profileId: "openai:configured",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () =>
        configWithPluginPolicy("llm-task", {
          allowAuthProfileOverride: true,
        }),
      authority: { allowComplete: true, preferredProfile: "openai:authority-bound" },
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "llm-task" }, () =>
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        systemPrompt: "JSON only",
        reasoning: "high",
        outputSchema,
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId: "openai:work",
          timeoutMs: 12_000,
        },
      }),
    );
    stop();

    expectSingleCallFirstArg(hoisted.runIsolatedCompletion, {
      purpose: "plugin-completion",
      config: expect.any(Object),
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:work",
      agentId: "main",
      systemPrompt: "JSON only",
      prompt: "Return JSON",
      timeoutMs: 12_000,
      thinkLevel: "high",
      outputSchema,
      streamParams: { maxTokens: undefined, temperature: undefined },
    });
    const forwardedSchema = hoisted.runIsolatedCompletion.mock.calls[0]?.[0]?.outputSchema;
    expect(forwardedSchema).toBe(outputSchema);
    expect(result).toMatchObject({
      text: "isolated",
      execution: {
        mode: "isolated-agent-runtime",
        owner: { kind: "harness", id: "openclaw" },
      },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      audit: { caller: { kind: "plugin", id: "llm-task" } },
    });
    expect(usageEvents).toEqual([
      {
        hostPluginId: "llm-task",
        internal: true,
        trusted: true,
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          promptTokens: 3,
          total: 5,
        },
      },
    ]);
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "isolated unknown tiered total",
      isolated: true,
      tiered: true,
      total: undefined,
      expected: undefined,
    },
    {
      name: "isolated flat estimate",
      isolated: true,
      tiered: false,
      total: undefined,
      expected: 0.3,
    },
    {
      name: "isolated recorded total",
      isolated: true,
      tiered: true,
      total: 0.125,
      expected: 0.125,
    },
    {
      name: "direct single-call tier",
      isolated: false,
      tiered: true,
      total: undefined,
      expected: 0.6,
    },
  ])("prices $name at its execution boundary", async ({ isolated, tiered, total, expected }) => {
    const selection = { provider: "fixture", modelId: "priced", agentDir: "/tmp/main" };
    const model = {
      id: "priced",
      name: "Priced",
      provider: "fixture",
      api: "openai-completions",
      baseUrl: "https://fixture.invalid",
      reasoning: false,
      input: ["text" as const],
      contextWindow: 1_000_000,
      maxTokens: 1_000,
      cost: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ...(tiered
          ? {
              tieredPricing: [
                { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, range: [200_000] as [number] },
              ],
            }
          : {}),
      },
    } satisfies Model<"openai-completions">;
    const usage = {
      input: 300_000,
      output: 200,
      ...(total !== undefined ? { cost: { total } } : {}),
    };
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce(selection);
    hoisted.runIsolatedCompletion.mockResolvedValueOnce({
      text: "isolated",
      provider: "fixture",
      model: "priced",
      owner: { kind: "cli", id: "fixture-cli" },
      usage,
    });
    hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValueOnce({
      async [Symbol.asyncDispose]() {},
      selection,
      model,
      auth: { mode: "api-key", source: "fixture" },
    });
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: "direct" }],
      stopReason: "stop",
      usage,
    });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        models: { providers: { fixture: { baseUrl: "https://fixture.invalid", models: [model] } } },
      }),
      authority: { allowComplete: true },
    });

    const messages: [{ role: "user"; content: string }] = [
      { role: "user", content: "Return JSON" },
    ];
    const request: Parameters<typeof llm.complete>[0] = isolated
      ? { messages, execution: { mode: "isolated-agent-runtime" } }
      : { messages };
    const result = await llm.complete(request);

    expect(result.usage.costUsd).toBe(expected);
  });

  it("keeps usage-free isolated completions silent", async () => {
    hoisted.runIsolatedCompletion.mockResolvedValueOnce({
      text: "isolated",
      provider: "openai",
      model: "gpt-5.5",
      owner: { kind: "cli", id: "claude-cli" },
    });
    const usageEvents: unknown[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        usageEvents.push(event);
      }
    });
    const llm = authorizedLlm();

    const result = await llm.complete(isolatedRequest());
    stop();

    expect(result.usage).toEqual({});
    expect(usageEvents).toEqual([]);
  });

  it.each([
    {
      name: "uses the authority-bound profile before the agent-configured profile",
      modelId: "gpt-5.5",
      configuredProfile: "openai:configured",
      preferredProfile: "openai:authority-bound",
      expectedProfile: "openai:authority-bound",
      model: undefined,
    },
    {
      name: "keeps an authorized model profile ahead of the authority-bound profile",
      modelId: "gpt-5.4",
      configuredProfile: "openai:model-profile",
      preferredProfile: "openai:authority-bound",
      expectedProfile: "openai:model-profile",
      model: "openai/gpt-5.4@openai:model-profile",
    },
    {
      name: "uses the agent-configured auth profile without treating it as an override",
      modelId: "gpt-5.5",
      configuredProfile: "openai:configured",
      preferredProfile: undefined,
      expectedProfile: "openai:configured",
      model: undefined,
    },
  ])("$name", async ({ modelId, configuredProfile, preferredProfile, expectedProfile, model }) => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId,
      profileId: configuredProfile,
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () =>
        model
          ? configWithPluginPolicy("model-plugin", {
              allowModelOverride: true,
              allowAuthProfileOverride: true,
              allowedModels: ["openai/gpt-5.4"],
            })
          : cfg,
      authority: { allowComplete: true, preferredProfile },
    });
    const complete = () => llm.complete(isolatedRequest(model ? { model } : {}));
    await expect(
      model ? withPluginRuntimePluginScope({ pluginId: "model-plugin" }, complete) : complete(),
    ).resolves.toMatchObject({ text: "isolated" });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expectedProfile }),
    );
  });

  it("denies request-level auth profiles without host policy", async () => {
    const llm = authorizedLlm();

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        llm.complete({
          messages: [{ role: "user", content: "Return JSON" }],
          execution: {
            mode: "isolated-agent-runtime",
            authProfileId: "openai:work",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("denies auth profiles selected through a model override without host policy", async () => {
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId: "gpt-5.4",
      profileId: "openai:work",
      agentDir: "/tmp/main",
    });
    const llm = createRuntimeLlm({
      getConfig: () =>
        configWithPluginPolicy("plain-plugin", {
          allowModelOverride: true,
          allowedModels: ["openai/gpt-5.4"],
        }),
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        llm.complete({
          model: "openai/gpt-5.4@openai:work",
          messages: [{ role: "user", content: "Return JSON" }],
          execution: { mode: "isolated-agent-runtime" },
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "validates isolated reasoning against the host-resolved model and runtime",
      request: { reasoning: "max" },
    },
    {
      name: "rejects chat histories before isolated runtime dispatch",
      request: {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
      },
    },
    {
      name: "rejects unknown execution modes instead of falling through to direct inference",
      request: { execution: { mode: "isoltaed-agent-runtime" } },
    },
    {
      name: "rejects direct-provider auth controls before isolated dispatch",
      request: { requiredAuthMode: "oauth" },
    },
    {
      name: "rejects direct-provider response controls before isolated dispatch",
      request: { responseFormat: { type: "json_object" } },
    },
  ])("$name", async ({ request }) => {
    const llm = authorizedLlm();
    await expect(
      llm.complete({
        ...isolatedRequest(),
        ...request,
      } as unknown as Parameters<typeof llm.complete>[0]),
    ).rejects.toMatchObject({
      code: "LLM_ISOLATED_INPUT_REJECTED",
    });
    expect(hoisted.runIsolatedCompletion).not.toHaveBeenCalled();
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "circular",
      () => {
        const schema: Record<string, unknown> = { type: "object" };
        schema.self = schema;
        return schema;
      },
    ],
    ["oversized", () => outputSchemaWithSerializedBytes(1_025)],
  ] as const)("does not forward %s schemas to the runtime owner", async (_name, schema) => {
    const llm = authorizedLlm();

    await expect(llm.complete(isolatedRequest({ outputSchema: schema() }))).resolves.toMatchObject({
      text: "isolated",
    });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledOnce();
    expect(hoisted.runIsolatedCompletion.mock.calls[0]?.[0]).not.toHaveProperty("outputSchema");
  });

  it("forwards schemas by reference at the 1 KiB boundary", async () => {
    const llm = authorizedLlm();
    const outputSchema = outputSchemaWithSerializedBytes(1_024);

    await llm.complete(isolatedRequest({ outputSchema }));

    expect(hoisted.runIsolatedCompletion.mock.calls[0]?.[0]?.outputSchema).toBe(outputSchema);
  });

  it.each([2_147_483_648, Number.NaN])("rejects invalid isolated timeout %s", async (timeoutMs) => {
    const llm = authorizedLlm();
    await expect(
      llm.complete(isolatedRequest({ execution: { mode: "isolated-agent-runtime", timeoutMs } })),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
  });

  it.each([null])("maps an empty adapter rejection (%s) to a stable error", async (error) => {
    hoisted.runIsolatedCompletion.mockRejectedValueOnce(error);
    const llm = authorizedLlm();

    await expect(llm.complete(isolatedRequest())).rejects.toMatchObject({
      code: "LLM_COMPLETION_FAILED",
      message: "Plugin LLM completion failed.",
    });
    expect(hoisted.runIsolatedCompletion).toHaveBeenCalledOnce();
  });

  it.each([
    ["input-rejected", "LLM_ISOLATED_INPUT_REJECTED"],
    ["output-rejected", "LLM_COMPLETION_OUTPUT_REJECTED"],
  ] as const)("maps %s adapter failures to %s", async (adapterCode, publicCode) => {
    const usageEvents: unknown[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        usageEvents.push(event);
      }
    });
    hoisted.runIsolatedCompletion.mockRejectedValueOnce(
      Object.assign(new Error(`adapter ${adapterCode}`), { code: adapterCode }),
    );
    const llm = authorizedLlm();

    await expect(llm.complete(isolatedRequest())).rejects.toMatchObject({ code: publicCode });
    stop();
    expect(usageEvents).toEqual([]);
  });

  it("codes isolated reload admission refusals as lifecycle failures", async () => {
    const refusal = new PreparedModelRuntimeInitialRunAdmissionError(
      new PreparedModelRuntimeOwnerNotPublishedError("Model runtime replacement is in progress", {
        admissionBlocked: true,
      }),
    );
    hoisted.runIsolatedCompletion.mockRejectedValueOnce(refusal);
    const llm = authorizedLlm();

    await expect(llm.complete(isolatedRequest())).rejects.toMatchObject({
      code: "LLM_RUNTIME_LIFECYCLE",
      message: refusal.message,
      cause: refusal,
    });
  });
});
