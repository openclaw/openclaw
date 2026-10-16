// Isolated runtime.llm.complete tests cover zero-tool dispatch and policy enforcement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginEntryConfig } from "../../config/types.plugins.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../infra/diagnostic-otel-listener-provenance.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm, type CreateRuntimeLlmOptions } from "./runtime-llm.runtime.js";
import type { LlmCompleteParams, LlmIsolatedAgentRuntimeCompleteParams } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  complete: vi.fn(),
  select: vi.fn(),
  isolated: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: hoisted.isolated }));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquire,
  completeWithPreparedSimpleCompletionModel: hoisted.complete,
  resolveSimpleCompletionSelectionForAgent: hoisted.select,
}));

const cfg = {
  agents: {
    defaults: { model: "openai/gpt-5.5" },
  },
} satisfies OpenClawConfig;

function configWithPluginPolicy(pluginId: string, llm: PluginEntryConfig["llm"]): OpenClawConfig {
  return { ...cfg, plugins: { entries: { [pluginId]: { llm } } } };
}

function runtime(options: CreateRuntimeLlmOptions = {}) {
  return createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true }, ...options });
}

function request(
  overrides: Partial<LlmIsolatedAgentRuntimeCompleteParams> = {},
): LlmIsolatedAgentRuntimeCompleteParams {
  return {
    messages: [{ role: "user", content: "Return JSON" }],
    execution: { mode: "isolated-agent-runtime" },
    ...overrides,
  };
}

function selectProfile(profileId: string, modelId = "gpt-5.5") {
  hoisted.select.mockReturnValueOnce({
    provider: "openai",
    modelId,
    profileId,
    agentDir: "/tmp/main",
  });
}

function primeCompletionMocks() {
  hoisted.select.mockImplementation((params: { modelRef?: string; agentId: string }) => {
    const slash = params.modelRef?.indexOf("/") ?? -1;
    return {
      provider: slash > 0 ? params.modelRef?.slice(0, slash) : "openai",
      modelId: slash > 0 ? params.modelRef?.slice(slash + 1) : (params.modelRef ?? "gpt-5.5"),
      agentDir: `/tmp/${params.agentId}`,
    };
  });
  hoisted.isolated.mockResolvedValue({
    text: "isolated",
    provider: "openai",
    model: "gpt-5.5",
    owner: { kind: "harness", id: "openclaw" },
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
  });
}

function captureUsageEvents() {
  const events: unknown[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
  return { events, stop };
}

function expectSingleCallFirstArg(mock: { mock: { calls: unknown[][] } }, expected: object) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
}

describe("runtime.llm.complete isolated agent runtime", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    hoisted.acquire.mockReset();
    hoisted.complete.mockReset();
    hoisted.select.mockReset();
    hoisted.isolated.mockReset();
    primeCompletionMocks();
  });

  it("routes authorized isolated completion through the configured agent runtime", async () => {
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
    selectProfile("openai:configured");
    const llm = runtime({
      getConfig: () => configWithPluginPolicy("llm-task", { allowAuthProfileOverride: true }),
      authority: { allowComplete: true, preferredProfile: "openai:authority-bound" },
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "llm-task" }, () =>
      llm.complete({
        messages: [{ role: "user", content: "Return JSON" }],
        systemPrompt: "JSON only",
        reasoning: "high",
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId: "openai:work",
          timeoutMs: 12_000,
        },
      }),
    );
    stop();

    expectSingleCallFirstArg(hoisted.isolated, {
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
      streamParams: { maxTokens: undefined, temperature: undefined },
    });
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
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, promptTokens: 3, total: 5 },
      },
    ]);
    expect(hoisted.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["isolated unknown tiered total", true, true, undefined, undefined],
    ["isolated flat estimate", true, false, undefined, 0.3],
    ["isolated recorded total", true, true, 0.125, 0.125],
    ["direct single-call tier", false, true, undefined, 0.6],
  ] as const)(
    "prices %s at its execution boundary",
    async (_name, isolated, tiered, total, expected) => {
      const selection = { provider: "fixture", modelId: "priced", agentDir: "/tmp/main" };
      const flatCost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
      const model = makeProviderModelFixture<"openai-completions">({
        id: "priced",
        name: "Priced",
        provider: "fixture",
        api: "openai-completions",
        baseUrl: "https://fixture.invalid",
        contextWindow: 1_000_000,
        maxTokens: 1_000,
        cost: tiered
          ? { ...flatCost, tieredPricing: [{ ...flatCost, input: 2, range: [200_000] }] }
          : flatCost,
      });
      const usage = {
        input: 300_000,
        output: 200,
        ...(total !== undefined ? { cost: { total } } : {}),
      };
      hoisted.select.mockReturnValueOnce(selection);
      hoisted.isolated.mockResolvedValueOnce({
        text: "isolated",
        provider: "fixture",
        model: "priced",
        owner: { kind: "cli", id: "fixture-cli" },
        usage,
      });
      hoisted.acquire.mockResolvedValueOnce({
        async [Symbol.asyncDispose]() {},
        selection,
        model,
        auth: { mode: "api-key", source: "fixture" },
      });
      hoisted.complete.mockResolvedValueOnce({
        content: [{ type: "text", text: "direct" }],
        stopReason: "stop",
        usage,
      });
      const llm = runtime({
        getConfig: () => ({
          models: {
            providers: { fixture: { baseUrl: "https://fixture.invalid", models: [model] } },
          },
        }),
      });

      const result = await llm.complete(isolated ? request() : { messages: request().messages });

      expect(result.usage.costUsd).toBe(expected);
    },
  );

  it("keeps usage-free isolated completions silent", async () => {
    hoisted.isolated.mockResolvedValueOnce({
      text: "isolated",
      provider: "openai",
      model: "gpt-5.5",
      owner: { kind: "cli", id: "claude-cli" },
    });
    const { events: usageEvents, stop } = captureUsageEvents();
    const result = await runtime().complete(request());
    stop();

    expect(result.usage).toEqual({});
    expect(usageEvents).toEqual([]);
  });

  it.each([
    ["authority-bound", undefined, "openai:authority-bound", "openai:authority-bound"],
    [
      "model override",
      "openai/gpt-5.4@openai:model-profile",
      "openai:authority-bound",
      "openai:model-profile",
    ],
    ["agent-configured", undefined, undefined, "openai:configured"],
  ] as const)(
    "uses the %s auth profile in precedence order",
    async (_name, model, preferredProfile, expected) => {
      selectProfile(
        model ? "openai:model-profile" : "openai:configured",
        model ? "gpt-5.4" : "gpt-5.5",
      );
      const llm = runtime({
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
      const complete = () => llm.complete(request(model ? { model } : {}));
      await expect(
        model ? withPluginRuntimePluginScope({ pluginId: "model-plugin" }, complete) : complete(),
      ).resolves.toMatchObject({ text: "isolated" });
      expect(hoisted.isolated).toHaveBeenCalledWith(
        expect.objectContaining({ authProfileId: expected }),
      );
    },
  );

  it("validates isolated reasoning against the host-resolved model and runtime", async () => {
    await expect(runtime().complete(request({ reasoning: "max" }))).rejects.toMatchObject({
      code: "LLM_ISOLATED_INPUT_REJECTED",
    });
    expect(hoisted.isolated).not.toHaveBeenCalled();
  });

  it.each(["request", "model"] as const)(
    "denies %s auth profile overrides without host policy",
    async (source) => {
      if (source === "model") {
        selectProfile("openai:work", "gpt-5.4");
      }
      const llm = runtime({
        getConfig: () =>
          source === "model"
            ? configWithPluginPolicy("plain-plugin", {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              })
            : cfg,
      });
      await expect(
        withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
          llm.complete(
            request(
              source === "model"
                ? { model: "openai/gpt-5.4@openai:work" }
                : { execution: { mode: "isolated-agent-runtime", authProfileId: "openai:work" } },
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
      expect(hoisted.isolated).not.toHaveBeenCalled();
    },
  );

  it("rejects chat histories before isolated runtime dispatch", async () => {
    await expect(
      runtime().complete({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
        execution: { mode: "isolated-agent-runtime" },
      } as unknown as LlmCompleteParams),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.isolated).not.toHaveBeenCalled();
  });

  it("rejects unknown execution modes instead of falling through to direct inference", async () => {
    await expect(
      runtime().complete({
        messages: [{ role: "user", content: "Return JSON" }],
        execution: { mode: "isoltaed-agent-runtime" },
      } as unknown as LlmCompleteParams),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
    expect(hoisted.isolated).not.toHaveBeenCalled();
    expect(hoisted.complete).not.toHaveBeenCalled();
  });

  it.each([{ requiredAuthMode: "oauth" }, { responseFormat: { type: "json_object" } }])(
    "rejects direct-provider controls before isolated dispatch: %j",
    async (controls) => {
      await expect(
        runtime().complete({ ...request(), ...controls } as unknown as LlmCompleteParams),
      ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
      expect(hoisted.isolated).not.toHaveBeenCalled();
      expect(hoisted.acquire).not.toHaveBeenCalled();
      expect(hoisted.complete).not.toHaveBeenCalled();
    },
  );

  it.each([2_147_483_648, Number.NaN])("rejects invalid isolated timeout %s", async (timeoutMs) => {
    await expect(
      runtime().complete(request({ execution: { mode: "isolated-agent-runtime", timeoutMs } })),
    ).rejects.toMatchObject({ code: "LLM_ISOLATED_INPUT_REJECTED" });
  });

  it("settles at the deadline when the isolated runtime ignores cancellation", async () => {
    hoisted.isolated.mockReturnValueOnce(new Promise(() => {}));
    await expect(
      runtime().complete(request({ execution: { mode: "isolated-agent-runtime", timeoutMs: 5 } })),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_TIMEOUT" });
  });

  it("settles on caller abort when the isolated runtime ignores cancellation", async () => {
    const started = createDeferredCore();
    hoisted.isolated.mockImplementationOnce(() => {
      started.resolve();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const completion = runtime().complete(request({ signal: controller.signal }));

    await started.promise;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "LLM_COMPLETION_ABORTED" });
  });

  it.each([null])("maps an empty adapter rejection (%s) to a stable error", async (error) => {
    hoisted.isolated.mockRejectedValueOnce(error);
    await expect(runtime().complete(request())).rejects.toMatchObject({
      code: "LLM_COMPLETION_FAILED",
      message: "Plugin LLM completion failed.",
    });
    expect(hoisted.isolated).toHaveBeenCalledOnce();
  });

  it.each([
    ["input-rejected", "LLM_ISOLATED_INPUT_REJECTED"],
    ["output-rejected", "LLM_COMPLETION_OUTPUT_REJECTED"],
  ] as const)("maps %s adapter failures to %s", async (adapterCode, publicCode) => {
    const { events: usageEvents, stop } = captureUsageEvents();
    hoisted.isolated.mockRejectedValueOnce(
      Object.assign(new Error(`adapter ${adapterCode}`), { code: adapterCode }),
    );
    await expect(runtime().complete(request())).rejects.toMatchObject({ code: publicCode });
    stop();
    expect(usageEvents).toEqual([]);
  });
});
