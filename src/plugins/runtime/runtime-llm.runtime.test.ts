import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import { runContextEngineMaintenance } from "../../agents/embedded-agent-runner/context-engine-maintenance.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginEntryConfig } from "../../config/types.plugins.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm, type CreateRuntimeLlmOptions } from "./runtime-llm.runtime.js";
import type { RuntimeLogger } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  complete: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquire,
  completeWithPreparedSimpleCompletionModel: hoisted.complete,
  resolveSimpleCompletionSelectionForAgent: hoisted.select,
}));

const cfg = { agents: { defaults: { model: "openai/gpt-5.5" } } } satisfies OpenClawConfig;

function configWithPluginPolicy(pluginId: string, llm: PluginEntryConfig["llm"]): OpenClawConfig {
  return { ...cfg, plugins: { entries: { [pluginId]: { llm } } } };
}

function runtime(options: CreateRuntimeLlmOptions = {}) {
  return createRuntimeLlm({
    getConfig: () => cfg,
    ...options,
    authority: { allowComplete: true, ...options.authority },
  });
}

function pluginComplete(
  llm: PluginEntryConfig["llm"],
  pluginId = "trusted-plugin",
  options: CreateRuntimeLlmOptions = {},
) {
  const scoped = runtime({
    getConfig: () => configWithPluginPolicy(pluginId.toLowerCase(), llm),
    ...options,
  });
  return (request: Parameters<typeof scoped.complete>[0]) =>
    withPluginRuntimePluginScope({ pluginId }, () => scoped.complete(request));
}

function context(overrides: Partial<Parameters<typeof resolveContextEngineCapabilities>[0]> = {}) {
  return resolveContextEngineCapabilities({
    config: cfg,
    sessionKey: "agent:main:session:abc",
    purpose: "context-engine.compaction",
    ...overrides,
  });
}

const messages = [{ role: "user" as const, content: "Ping" }];
const summaryMessages = [{ role: "user" as const, content: "summarize" }];

function createPreparedModel(
  modelId = "gpt-5.5",
): Extract<Awaited<ReturnType<typeof hoisted.acquire>>, { model: unknown }> {
  return {
    async [Symbol.asyncDispose]() {},
    selection: { provider: "openai", modelId, agentDir: "/tmp/openclaw-agent" },
    model: makeProviderModelFixture({
      provider: "openai",
      id: modelId,
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
    }),
    auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
  };
}

function createLogger(): RuntimeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

function expectSingleCallFirstArg(mock: MockCalls, expected: object) {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toMatchObject(expected);
}

function expectSingleLogPayload(mock: MockCalls, message: string, expected: object) {
  expect(mock.mock.calls).toEqual([[message, expect.objectContaining(expected)]]);
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.acquire.mockReset().mockResolvedValue(createPreparedModel());
    hoisted.select
      .mockReset()
      .mockImplementation((params: { modelRef?: string; agentId: string }) => {
        const modelRef = params.modelRef || "gpt-5.5";
        const slash = modelRef.indexOf("/");
        return {
          provider: slash > 0 ? modelRef.slice(0, slash) : "openai",
          modelId: slash > 0 ? modelRef.slice(slash + 1) : modelRef,
          agentDir: `/tmp/${params.agentId}`,
        };
      });
    hoisted.complete.mockReset().mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      responseModel: "gpt-5.5-2026-08-01",
      stopReason: "stop",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      },
    });
  });

  it("denies context-engine model overrides without owning plugin llm policy", async () => {
    const runtimeContext = context({ contextEnginePluginId: "lossless-claw" });

    await expect(
      runtimeContext.llm!.complete({ model: "openai/gpt-5.4-mini", messages: summaryMessages }),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("binds context-engine completions to the active session agent", async () => {
    const runtimeContext = context({
      sessionKey: "agent:ada:session:abc",
      authProfileId: "openai:configured",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: summaryMessages,
      purpose: "memory-maintenance",
    });

    expectSingleCallFirstArg(hoisted.acquire, {
      cfg,
      agentId: "ada",
      preferredProfile: "openai:configured",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
    expect(result).toMatchObject({
      agentId: "ada",
      audit: {
        caller: { kind: "context-engine", id: "context-engine.after-turn" },
        purpose: "memory-maintenance",
        sessionKey: "agent:ada:session:abc",
      },
    });
  });

  it("does not trust a fallback-derived agent in the after-turn caller", async () => {
    const attempt = {
      sessionKey: "legacy-session",
      config: cfg,
      skillsSnapshot: undefined,
      provider: "openai",
      modelId: "gpt-5.5",
      thinkLevel: "off" as const,
    } satisfies Parameters<typeof buildAfterTurnRuntimeContext>[0]["attempt"];
    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      activeAgentId: "main",
    });

    await expect(runtimeContext.llm!.complete({ messages: summaryMessages })).rejects.toThrow(
      "not bound to an active session agent",
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();

    const maintain = vi.fn(async (params: { runtimeContext?: typeof runtimeContext }) => {
      await params.runtimeContext?.llm?.complete({
        messages: [{ role: "user", content: "maintain" }],
      });
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    });
    const maintenanceResult = await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test" },
        maintain,
      } as never,
      sessionId: "legacy-session",
      sessionKey: "legacy-session",
      sessionFile: "legacy-session",
      reason: "turn",
      config: cfg,
      agentId: "main",
      runtimeContext,
    });

    expect(maintain).toHaveBeenCalledOnce();
    expect(maintenanceResult).toBeUndefined();
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("accepts an explicitly trusted pre-fallback agent", async () => {
    const runtimeContext = context({
      sessionKey: "legacy-session",
      explicitAgentId: "ada",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({ messages: summaryMessages });

    expect(result.agentId).toBe("ada");
  });

  it("matches allowlist entries for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = context({
      config: configWithPluginPolicy("lossless-claw", {
        allowModelOverride: true,
        allowedModels: ["openrouter/gpt-5.4-mini"],
      }),
      contextEnginePluginId: "lossless-claw",
    });

    hoisted.acquire.mockResolvedValue(createPreparedModel("openrouter/gpt-5.4-mini"));
    hoisted.select.mockImplementation((params: { agentId: string }) => ({
      provider: "openrouter",
      modelId: "openrouter/gpt-5.4-mini",
      agentDir: `/tmp/${params.agentId}`,
    }));

    await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openrouter/gpt-5.4-mini",
      messages: summaryMessages,
    });

    expectSingleCallFirstArg(hoisted.acquire, {
      agentId: "main",
      modelRef: "openrouter/gpt-5.4-mini",
    });
  });

  it("keeps context-engine attribution and host-derived policy inside plugin runtime scope", async () => {
    const runtimeContext = context({
      config: configWithPluginPolicy("lossless-claw", {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      }),
      contextEnginePluginId: "lossless-claw",
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "spoofed-plugin" }, () =>
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: summaryMessages,
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<NonNullable<typeof runtimeContext.llm>["complete"]>[0] & {
        caller: unknown;
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.compaction",
    });
    expectSingleCallFirstArg(hoisted.acquire, { modelRef: "openai/gpt-5.4-mini" });
  });

  it("allows the bound context-engine agent and denies cross-agent overrides", async () => {
    const runtimeContext = context({ sessionKey: "main" });

    await runtimeContext.llm!.complete({ agentId: "main", messages: summaryMessages });
    expectSingleCallFirstArg(hoisted.acquire, { agentId: "main" });

    await expect(
      runtimeContext.llm!.complete({ agentId: "worker", messages: summaryMessages }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("ignores request auth profile preferences without a trusted authority binding", async () => {
    const llm = runtime();

    await llm.complete({
      authProfileId: "openai:work",
      messages: [{ role: "user", content: "draft" }],
    } as Parameters<typeof llm.complete>[0] & { authProfileId: string });

    expectSingleCallFirstArg(hoisted.acquire, { cfg, agentId: "main" });
    expect(hoisted.acquire.mock.calls[0]?.[0]?.preferredProfile).toBeUndefined();
  });

  it("allows host model overrides only when explicit authority allowlists the model", async () => {
    const llm = runtime({
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
      },
    });

    await llm.complete({ model: "openai/gpt-5.4", messages });
    expectSingleCallFirstArg(hoisted.acquire, { modelRef: "openai/gpt-5.4" });

    await expect(llm.complete({ model: "openai/gpt-5.5", messages })).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted',
    );
  });

  it("requires model overrides to satisfy host and plugin allowlists", async () => {
    const complete = pluginComplete(
      { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
      "restricted-plugin",
      { authority: { allowModelOverride: true, allowedModels: ["openai/gpt-5.5"] } },
    );

    await expect(complete({ model: "openai/gpt-5.5", messages })).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "restricted-plugin"',
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("uses runtime-scoped config and the host preparation/dispatch path", async () => {
    const logger = createLogger();
    const llm = runtime({
      logger,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
      },
    });

    const result = await llm.complete({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Ping" },
      ],
      temperature: 0.2,
      maxTokens: 64,
      reasoning: "ultra",
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "test_result", strict: true, schema: { type: "object" } },
      },
      purpose: "test-purpose",
    });

    expectSingleCallFirstArg(hoisted.acquire, { cfg, agentId: "main" });
    expectSingleCallFirstArg(hoisted.complete, {
      cfg,
      context: expect.objectContaining({
        systemPrompt: "Be terse.",
        messages: [expect.objectContaining({ role: "user", content: "Ping" })],
      }),
      options: expect.objectContaining({
        maxTokens: 64,
        temperature: 0.2,
        reasoning: "ultra",
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "test_result", strict: true, schema: { type: "object" } },
        },
      }),
    });
    expect(result).toMatchObject({
      text: "done",
      provider: "openai",
      model: "gpt-5.5",
      responseModel: "gpt-5.5-2026-08-01",
      stopReason: "stop",
      usage: expect.objectContaining({
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 25,
        costUsd: 0.0042,
      }),
    });
    expectSingleLogPayload(vi.mocked(logger.info), "plugin llm completion", {
      caller: { kind: "host", id: "runtime-test" },
      purpose: "test-purpose",
      usage: expect.objectContaining({ costUsd: 0.0042 }),
    });
  });

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = createLogger();
    const llm = runtime({
      logger,
      authority: {
        caller: { kind: "host", id: "ignored-host" },
      },
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      llm.complete({
        messages,
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expectSingleLogPayload(vi.mocked(logger.info), "plugin llm completion", {
      caller: { kind: "plugin", id: "trusted-plugin" },
      purpose: "identity-test",
    });
  });

  it("denies plugin model overrides by default", async () => {
    const llm = runtime();

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        llm.complete({ model: "openai/gpt-5.4", messages }),
      ),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = runtime();

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        denied.complete({ agentId: "worker", messages }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    await pluginComplete({ allowAgentIdOverride: true })({ agentId: "worker", messages });
    expectSingleCallFirstArg(hoisted.acquire, { agentId: "worker" });
  });

  it("allows model overrides for case-insensitive plugin ids only when configured and allowlisted", async () => {
    const complete = pluginComplete(
      { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
      "TrUsTeD-plugin",
    );
    await complete({ model: "openai/gpt-5.4", messages });
    expectSingleCallFirstArg(hoisted.acquire, { agentId: "main", modelRef: "openai/gpt-5.4" });

    await expect(complete({ model: "openai/gpt-5.6", messages })).rejects.toThrow(
      'model override "openai/gpt-5.6" is not allowlisted',
    );
  });

  it("applies the completion allowlist to the host-resolved default for case-insensitive plugin ids", async () => {
    const complete = pluginComplete(
      { allowedCompletionModels: ["anthropic/claude-haiku-4-5"] },
      "ReStRiCtEd-plugin",
    );
    await expect(complete({ messages })).rejects.toThrow(
      'model "openai/gpt-5.5" is not allowlisted for completions',
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("fails closed for an unusable completion allowlist", async () => {
    const complete = pluginComplete(
      { allowedCompletionModels: ["not-a-canonical-model-ref"] },
      "restricted-plugin",
    );
    await expect(complete({ messages })).rejects.toThrow(
      "completion model allowlist has no valid models",
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = createLogger();
    const llm = runtime({
      logger,
      authority: { allowComplete: false, denyReason: "not trusted" },
    });

    await expect(llm.complete({ messages })).rejects.toThrow(
      "Plugin LLM completion denied: not trusted",
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();
    expectSingleLogPayload(vi.mocked(logger.warn), "plugin llm completion denied", {
      reason: "not trusted",
    });
  });
});
