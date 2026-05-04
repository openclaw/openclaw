import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/pi-embedded-runner/context-engine-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { RuntimeLogger } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel() {
  return {
    selection: {
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  };
}

function createLogger(): RuntimeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function primeCompletionMocks() {
  hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
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
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    primeCompletionMocks();
  });

  it("binds context-engine completions to the active session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
      purpose: "memory-maintenance",
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        agentId: "ada",
        allowMissingApiKeyModes: ["aws-sdk"],
      }),
    );
    expect(result.agentId).toBe("ada");
    expect(result.audit).toMatchObject({
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
    });
  });

  it("does not fall back to the default agent for unbound active-session hooks", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "legacy-session",
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("allows explicit agentId for non-session plugin calls", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        allowAgentIdOverride: true,
        allowModelOverride: true,
        allowComplete: true,
      },
    });

    await llm.complete({
      agentId: "worker",
      messages: [{ role: "user", content: "draft" }],
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        agentId: "worker",
      }),
    );
  });

  it("uses request-scoped config and the host preparation/dispatch path", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
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
      purpose: "test-purpose",
      caller: { kind: "plugin", id: "test-plugin" },
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cfg, agentId: "main" }),
    );
    expect(hoisted.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        context: expect.objectContaining({
          systemPrompt: "Be terse.",
          messages: [expect.objectContaining({ role: "user", content: "Ping" })],
        }),
        options: expect.objectContaining({
          maxTokens: 64,
          temperature: 0.2,
        }),
      }),
    );
    expect(result).toMatchObject({
      text: "done",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 25,
        costUsd: 0.0042,
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      "plugin llm completion",
      expect.objectContaining({
        caller: { kind: "plugin", id: "test-plugin" },
        purpose: "test-purpose",
        usage: expect.objectContaining({ costUsd: 0.0042 }),
      }),
    );
  });

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
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
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "plugin llm completion denied",
      expect.objectContaining({ reason: "not trusted" }),
    );
  });
});
