// Runtime LLM tests cover plugin provider hooks inside the model runtime adapter.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import { runContextEngineMaintenance } from "../../agents/embedded-agent-runner/context-engine-maintenance.js";
import { buildAfterTurnRuntimeContext } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePluginGenerationRetiredError,
} from "../../agents/prepared-model-runtime.errors.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { createRuntimeLlmUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginEntryConfig } from "../../config/types.plugins.js";
import { AsyncWorkScopeClosedError } from "../../shared/async-work-scope.js";
import { PluginInventoryRetiredError } from "../plugin-instance-error.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
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

function configWithPluginPolicy(pluginId: string, llm: PluginEntryConfig["llm"]): OpenClawConfig {
  return { ...cfg, plugins: { entries: { [pluginId]: { llm } } } };
}

function createPreparedModel(
  modelId = "gpt-5.5",
): Extract<
  Awaited<ReturnType<typeof hoisted.acquireSimpleCompletionModelForAgent>>,
  { model: unknown }
> {
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

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const [firstArg] = mock.mock.calls[0] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function expectSingleLogPayload(
  loggerMethod: MockCalls,
  message: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(loggerMethod.mock.calls).toHaveLength(1);
  const [actualMessage, payload] = loggerMethod.mock.calls[0] ?? [];
  expect(actualMessage).toBe(message);
  const payloadRecord = requireRecord(payload, "log payload");
  expectFields(payloadRecord, expected);
  return payloadRecord;
}

function primeCompletionMocks(usage = createRuntimeLlmUsageFixture()) {
  hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
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
    },
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    responseModel: "gpt-5.5-2026-08-01",
    stopReason: "stop",
    usage,
  });
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    Object.values(hoisted.logger).forEach((method) => method.mockClear());
    primeCompletionMocks();
  });

  it("denies context-engine model overrides without owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("binds context-engine completions to the active session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      authProfileId: "openai:configured",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
      purpose: "memory-maintenance",
    });

    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      cfg,
      agentId: "ada",
      preferredProfile: "openai:configured",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
    expect(result.agentId).toBe("ada");
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
    });
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
    hoisted.acquireSimpleCompletionModelForAgent.mockRejectedValue(refusal);
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.compaction",
    });

    const error = await runtimeContext
      .llm!.complete({ messages: [{ role: "user", content: "summarize" }] })
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
    hoisted.acquireSimpleCompletionModelForAgent.mockRejectedValue(missingOwner);
    const llm = createRuntimeLlm({ getConfig: () => cfg });

    const error = await llm
      .complete({ messages: [{ role: "user", content: "summarize" }] })
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
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();

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
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("accepts an explicitly trusted pre-fallback agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "legacy-session",
      explicitAgentId: "ada",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });

    expect(result.agentId).toBe("ada");
  });

  it("matches allowlist entries for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: configWithPluginPolicy("lossless-claw", {
        allowModelOverride: true,
        allowedModels: ["openrouter/gpt-5.4-mini"],
      }),
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("openrouter/gpt-5.4-mini"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { agentId: string }) => ({
        provider: "openrouter",
        modelId: "openrouter/gpt-5.4-mini",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );

    await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openrouter/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openrouter/gpt-5.4-mini",
    });
  });

  it("keeps context-engine attribution and host-derived policy inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: configWithPluginPolicy("lossless-claw", {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      }),
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "spoofed-plugin" }, () =>
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<NonNullable<typeof runtimeContext.llm>["complete"]>[0] & {
        caller: unknown;
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.compaction",
    });
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4-mini",
    });
  });

  it("allows the bound context-engine agent and denies cross-agent overrides", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "main",
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({
      agentId: "main",
      messages: [{ role: "user", content: "summarize" }],
    });
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      agentId: "main",
    });

    await expect(
      runtimeContext.llm!.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("ignores request auth profile preferences without a trusted authority binding", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await llm.complete({
      authProfileId: "openai:work",
      messages: [{ role: "user", content: "draft" }],
    } as Parameters<typeof llm.complete>[0] & { authProfileId: string });

    const call = expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      cfg,
      agentId: "main",
    });
    expect(call.preferredProfile).toBeUndefined();
  });

  it("allows host model overrides only when explicit authority allowlists the model", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
        allowComplete: true,
      },
    });

    await llm.complete({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "Ping" }],
    });
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
  });

  it("requires model overrides to satisfy host and plugin allowlists", async () => {
    const llm = createRuntimeLlm({
      getConfig: () =>
        configWithPluginPolicy("restricted-plugin", {
          allowModelOverride: true,
          allowedModels: ["openai/gpt-5.4"],
        }),
      authority: {
        allowComplete: true,
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.5"],
      },
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "restricted-plugin" }, () =>
        llm.complete({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "restricted-plugin"',
    );
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it.each([0.0042, 0])(
    "preserves billed cost %s through host dispatch and logging",
    async (costUsd) => {
      const usage = {
        ...createRuntimeLlmUsageFixture(),
        cost: { total: costUsd, totalOrigin: "provider-billed" },
      };
      primeCompletionMocks(usage);
      const logger = hoisted.logger;
      const llm = createRuntimeLlm({
        getConfig: () => cfg,
        authority: {
          caller: { kind: "host", id: "runtime-test" },
          allowComplete: true,
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

      expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
        cfg,
        agentId: "main",
      });
      const completionArg = expectSingleCallFirstArg(
        hoisted.completeWithPreparedSimpleCompletionModel,
        {
          cfg,
        },
      );
      const context = requireRecord(completionArg.context, "completion context");
      expect(context.systemPrompt).toBe("Be terse.");
      const [message] = requireArray(context.messages, "completion messages");
      expectFields(requireRecord(message, "completion message"), {
        role: "user",
        content: "Ping",
      });
      expectFields(requireRecord(completionArg.options, "completion options"), {
        maxTokens: 64,
        temperature: 0.2,
        reasoning: "ultra",
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "test_result", strict: true, schema: { type: "object" } },
        },
      });
      expectFields(requireRecord(result, "completion result"), {
        text: "done",
        provider: "openai",
        model: "gpt-5.5",
        responseModel: "gpt-5.5-2026-08-01",
        stopReason: "stop",
      });
      expectFields(requireRecord(result.usage, "completion usage"), {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 25,
        costUsd,
      });
      const logPayload = expectSingleLogPayload(
        logger.info as unknown as MockCalls,
        "plugin llm completion",
        {
          caller: { kind: "host", id: "runtime-test" },
          purpose: "test-purpose",
        },
      );
      expectFields(requireRecord(logPayload.usage, "log usage"), { costUsd });
    },
  );

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = hoisted.logger;
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "ignored-host" },
        allowComplete: true,
      },
    });

    const result = await withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expectSingleLogPayload(logger.info as unknown as MockCalls, "plugin llm completion", {
      caller: { kind: "plugin", id: "trusted-plugin" },
      purpose: "identity-test",
    });
  });

  it("denies plugin model overrides by default", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "plain-plugin" }, () =>
        denied.complete({
          agentId: "worker",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    const allowed = createRuntimeLlm({
      getConfig: () =>
        configWithPluginPolicy("trusted-plugin", {
          allowAgentIdOverride: true,
        }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginScope({ pluginId: "trusted-plugin" }, () =>
      allowed.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      agentId: "worker",
    });
  });

  it.each(["TrUsTeD-plugin"])(
    "allows model overrides for %s only when configured and allowlisted",
    async (pluginId) => {
      const llm = createRuntimeLlm({
        getConfig: () =>
          configWithPluginPolicy("trusted-plugin", {
            allowModelOverride: true,
            allowedModels: ["openai/gpt-5.4"],
          }),
        authority: {
          allowComplete: true,
        },
      });

      await withPluginRuntimePluginScope({ pluginId }, () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Ping" }],
        }),
      );
      expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
        agentId: "main",
        modelRef: "openai/gpt-5.4",
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId }, () =>
          llm.complete({
            model: "openai/gpt-5.6",
            messages: [{ role: "user", content: "Ping" }],
          }),
        ),
      ).rejects.toThrow('model override "openai/gpt-5.6" is not allowlisted');
    },
  );

  it.each(["ReStRiCtEd-plugin"])(
    "applies the completion allowlist to the host-resolved default for %s",
    async (pluginId) => {
      const llm = createRuntimeLlm({
        getConfig: () =>
          configWithPluginPolicy("restricted-plugin", {
            allowedCompletionModels: ["anthropic/claude-haiku-4-5"],
          }),
        authority: { allowComplete: true },
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId }, () =>
          llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
        ),
      ).rejects.toThrow('model "openai/gpt-5.5" is not allowlisted for completions');
      expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    },
  );

  it.each([[["not-a-canonical-model-ref"]]])(
    "fails closed for an unusable completion allowlist %j",
    async (allowedCompletionModels) => {
      const llm = createRuntimeLlm({
        getConfig: () => configWithPluginPolicy("restricted-plugin", { allowedCompletionModels }),
        authority: { allowComplete: true },
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId: "restricted-plugin" }, () =>
          llm.complete({ messages: [{ role: "user", content: "Ping" }] }),
        ),
      ).rejects.toThrow("completion model allowlist has no valid models");
      expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    },
  );

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = hoisted.logger;
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: false,
        denyReason: "not trusted",
      },
    });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow("Plugin LLM completion denied: not trusted");
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expectSingleLogPayload(logger.warn as unknown as MockCalls, "plugin llm completion denied", {
      reason: "not trusted",
    });
  });
});
