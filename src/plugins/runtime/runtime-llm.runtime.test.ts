// Runtime LLM tests cover plugin provider hooks inside the model runtime adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import { runContextEngineMaintenance } from "../../agents/embedded-agent-runner/context-engine-maintenance.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePluginGenerationRetiredError,
} from "../../agents/prepared-model-runtime.errors.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginEntryConfig } from "../../config/types.plugins.js";
import { AsyncWorkScopeClosedError } from "../../shared/async-work-scope.js";
import { PluginInventoryRetiredError } from "../plugin-instance-error.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm, type RuntimeLlmAuthority } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  complete: vi.fn(),
  select: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquire,
  completeWithPreparedSimpleCompletionModel: hoisted.complete,
  resolveSimpleCompletionSelectionForAgent: hoisted.select,
}));

vi.mock(import("./runtime-logging.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeRuntimeLog: (_logger, level, message, meta) => hoisted.logger[level](message, meta),
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function runtime(authority?: RuntimeLlmAuthority, config: OpenClawConfig = cfg) {
  return createRuntimeLlm({ getConfig: () => config, authority });
}

function messages(content = "Ping") {
  return [{ role: "user" as const, content }];
}

function context(overrides: Partial<Parameters<typeof resolveContextEngineCapabilities>[0]> = {}) {
  return resolveContextEngineCapabilities({
    config: cfg,
    sessionKey: "agent:main:session:abc",
    purpose: "context-engine.compaction",
    ...overrides,
  });
}

function configWithPluginPolicy(pluginId: string, llm: PluginEntryConfig["llm"]): OpenClawConfig {
  return { ...cfg, plugins: { entries: { [pluginId]: { llm } } } };
}

function createPreparedModel(
  modelId = "gpt-5.5",
): Extract<Awaited<ReturnType<typeof hoisted.acquire>>, { model: unknown }> {
  return {
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: makeProviderModelFixture({
      provider: "openai",
      id: modelId,
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      contextWindow: 128_000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    }),
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  };
}

function expectSingleCallFirstArg(
  mock: { mock: { calls: unknown[][] } },
  expected: Record<string, unknown>,
): void {
  expect(mock.mock.calls).toEqual([[expect.objectContaining(expected)]]);
}

function expectSingleLogPayload(
  loggerMethod: { mock: { calls: unknown[][] } },
  message: string,
  expected: Record<string, unknown>,
): void {
  expect(loggerMethod.mock.calls).toEqual([[message, expect.objectContaining(expected)]]);
}

function primeCompletionMocks() {
  hoisted.acquire.mockResolvedValue(createPreparedModel());
  hoisted.select.mockImplementation((params: { modelRef?: string; agentId: string }) => {
    if (!params.modelRef) {
      return {
        provider: "openai",
        modelId: "gpt-5.5",
        agentDir: `/tmp/${params.agentId}`,
      };
    }
    const slash = params.modelRef.indexOf("/");
    return {
      provider: slash > 0 ? params.modelRef.slice(0, slash) : "openai",
      modelId: slash > 0 ? params.modelRef.slice(slash + 1) : params.modelRef,
      agentDir: `/tmp/${params.agentId}`,
    };
  });
  hoisted.complete.mockResolvedValue({
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
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.acquire.mockReset();
    hoisted.complete.mockReset();
    hoisted.select.mockReset();
    Object.values(hoisted.logger).forEach((method) => method.mockClear());
    primeCompletionMocks();
  });

  it("denies context-engine model overrides without owning plugin llm policy", async () => {
    const runtimeContext = context({
      contextEnginePluginId: "lossless-claw",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: messages("summarize"),
      }),
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
      messages: messages("summarize"),
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
    expect(result.agentId).toBe("ada");
    expect(result.audit).toEqual(
      expect.objectContaining({
        caller: { kind: "context-engine", id: "context-engine.after-turn" },
        purpose: "memory-maintenance",
        sessionKey: "agent:ada:session:abc",
      }),
    );
  });

  it.each([
    new PreparedModelRuntimeOwnerNotPublishedError(
      "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      { admissionBlocked: true },
    ),
    new PreparedModelRuntimePluginGenerationRetiredError("plugin generation retired"),
    new PluginInventoryRetiredError(),
    new AsyncWorkScopeClosedError(),
  ])("codes host lifecycle refusals so callers can retry later: $message", async (refusal) => {
    hoisted.acquire.mockRejectedValue(refusal);
    const runtimeContext = context({});

    const error = await runtimeContext
      .llm!.complete({ messages: messages("summarize") })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "LlmCompleteError",
      code: "LLM_RUNTIME_LIFECYCLE",
      message: refusal.message,
      cause: refusal,
    });
  });

  it("keeps a missing published owner a completion failure", async () => {
    const missingOwner = new PreparedModelRuntimeOwnerNotPublishedError(
      "owner was never published",
    );
    hoisted.acquire.mockRejectedValue(missingOwner);
    const llm = runtime();

    const error = await llm
      .complete({ messages: messages("summarize") })
      .catch((caught: unknown) => caught);

    expect(error).toBe(missingOwner);
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

    await expect(
      runtimeContext.llm!.complete({
        messages: messages("summarize"),
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.acquire).not.toHaveBeenCalled();

    const maintain = vi.fn(async (params: { runtimeContext?: typeof runtimeContext }) => {
      await params.runtimeContext?.llm?.complete({
        messages: messages("maintain"),
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

    const result = await runtimeContext.llm!.complete({
      messages: messages("summarize"),
    });

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
      messages: messages("summarize"),
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
        messages: messages("summarize"),
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<NonNullable<typeof runtimeContext.llm>["complete"]>[0] & {
        caller: unknown;
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.compaction",
    });
    expectSingleCallFirstArg(hoisted.acquire, {
      modelRef: "openai/gpt-5.4-mini",
    });
  });

  it("allows the bound context-engine agent and denies cross-agent overrides", async () => {
    const runtimeContext = context({
      sessionKey: "main",
    });

    await runtimeContext.llm!.complete({
      agentId: "main",
      messages: messages("summarize"),
    });
    expectSingleCallFirstArg(hoisted.acquire, {
      agentId: "main",
    });

    await expect(
      runtimeContext.llm!.complete({
        agentId: "worker",
        messages: messages("summarize"),
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("ignores request auth profile preferences without a trusted authority binding", async () => {
    const llm = runtime({ allowComplete: true });

    await llm.complete({
      authProfileId: "openai:work",
      messages: messages("draft"),
    } as Parameters<typeof llm.complete>[0] & { authProfileId: string });

    expectSingleCallFirstArg(hoisted.acquire, {
      cfg,
      agentId: "main",
      preferredProfile: undefined,
    });
  });

  it("allows host model overrides only when explicit authority allowlists the model", async () => {
    const llm = runtime({
      caller: { kind: "host", id: "runtime-test" },
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4"],
      allowComplete: true,
    });

    await llm.complete({
      model: "openai/gpt-5.4",
      messages: messages(),
    });
    expectSingleCallFirstArg(hoisted.acquire, {
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.5",
        messages: messages(),
      }),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
  });

  it("requires model overrides to satisfy host and plugin allowlists", async () => {
    const llm = runtime(
      {
        allowComplete: true,
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.5"],
      },
      configWithPluginPolicy("restricted-plugin", {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
      }),
    );

    await expect(
      withPluginRuntimePluginScope({ pluginId: "restricted-plugin" }, () =>
        llm.complete({
          model: "openai/gpt-5.5",
          messages: messages(),
        }),
      ),
    ).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "restricted-plugin"',
    );
    expect(hoisted.acquire).not.toHaveBeenCalled();
  });

  it("uses runtime-scoped config and the host preparation/dispatch path", async () => {
    const logger = hoisted.logger;
    const llm = runtime({
      caller: { kind: "host", id: "runtime-test" },
      allowComplete: true,
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

    expectSingleCallFirstArg(hoisted.acquire, {
      cfg,
      agentId: "main",
    });
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
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 25,
        costUsd: 0.0042,
      },
    });
    expectSingleLogPayload(logger.info, "plugin llm completion", {
      caller: { kind: "host", id: "runtime-test" },
      purpose: "test-purpose",
      usage: expect.objectContaining({ costUsd: 0.0042 }),
    });
  });

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = hoisted.logger;
    const llm = runtime({
      caller: { kind: "host", id: "ignored-host" },
      allowComplete: true,
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      llm.complete({
        messages: messages(),
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expectSingleLogPayload(logger.info, "plugin llm completion", {
      caller: { kind: "plugin", id: "trusted-plugin" },
      purpose: "identity-test",
    });
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = runtime({ allowComplete: true });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        denied.complete({
          agentId: "worker",
          messages: messages(),
        }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    const allowed = runtime(
      { allowComplete: true },
      configWithPluginPolicy("trusted-plugin", {
        allowAgentIdOverride: true,
      }),
    );

    await withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      allowed.complete({
        agentId: "worker",
        messages: messages(),
      }),
    );
    expectSingleCallFirstArg(hoisted.acquire, {
      agentId: "worker",
    });
  });

  it.each(["TrUsTeD-plugin"])(
    "allows model overrides for %s only when configured and allowlisted",
    async (pluginId) => {
      const llm = runtime(
        { allowComplete: true },
        configWithPluginPolicy("trusted-plugin", {
          allowModelOverride: true,
          allowedModels: ["openai/gpt-5.4"],
        }),
      );

      await withPluginRuntimePluginScope({ pluginId }, () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: messages(),
        }),
      );
      expectSingleCallFirstArg(hoisted.acquire, {
        agentId: "main",
        modelRef: "openai/gpt-5.4",
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId }, () =>
          llm.complete({
            model: "openai/gpt-5.6",
            messages: messages(),
          }),
        ),
      ).rejects.toThrow('model override "openai/gpt-5.6" is not allowlisted');
    },
  );

  it.each([
    [
      "default model override",
      "plain-plugin",
      undefined,
      { model: "openai/gpt-5.4" },
      "cannot override the target model",
    ],
    [
      "resolved completion allowlist",
      "ReStRiCtEd-plugin",
      { allowedCompletionModels: ["anthropic/claude-haiku-4-5"] },
      {},
      'model "openai/gpt-5.5" is not allowlisted for completions',
    ],
    [
      "invalid completion allowlist",
      "restricted-plugin",
      { allowedCompletionModels: ["not-a-canonical-model-ref"] },
      {},
      "completion model allowlist has no valid models",
    ],
  ] satisfies Array<[string, string, PluginEntryConfig["llm"], { model?: string }, string]>)(
    "denies %s",
    async (_name, pluginId, policy, override, error) => {
      const llm = runtime(
        { allowComplete: true },
        policy ? configWithPluginPolicy(pluginId.toLowerCase(), policy) : cfg,
      );
      await expect(
        withPluginRuntimePluginScope({ pluginId }, () =>
          llm.complete({ messages: messages(), ...override }),
        ),
      ).rejects.toThrow(error);
      expect(hoisted.acquire).not.toHaveBeenCalled();
    },
  );

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = hoisted.logger;
    const llm = runtime({
      allowComplete: false,
      denyReason: "not trusted",
    });

    await expect(
      llm.complete({
        messages: messages(),
      }),
    ).rejects.toThrow("Plugin LLM completion denied: not trusted");
    expect(hoisted.acquire).not.toHaveBeenCalled();
    expectSingleLogPayload(logger.warn, "plugin llm completion denied", {
      reason: "not trusted",
    });
  });
});
