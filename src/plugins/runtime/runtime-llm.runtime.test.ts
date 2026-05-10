import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/pi-embedded-runner/context-engine-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { RuntimeLogger } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  resolveAutoImageModel: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

vi.mock("../../media-understanding/runner.js", () => ({
  resolveAutoImageModel: hoisted.resolveAutoImageModel,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel(modelId = "gpt-5.5", input: string[] = ["text"]) {
  return {
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: modelId,
      name: modelId,
      api: "openai",
      input,
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
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 25,
      cost: { total: 0.0042 },
    },
  });
  hoisted.resolveAutoImageModel.mockResolvedValue(null);
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.resolveAutoImageModel.mockReset();
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

  it("binds context-engine structured completions to the active session agent", async () => {
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"summary":"ok"}' }],
      usage: {
        input: 4,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        total: 7,
        cost: { total: 0.001 },
      },
    });
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.completeStructured({
      instructions: "Extract a short summary.",
      input: [{ type: "text", text: "Customer said the rollout worked." }],
      jsonMode: true,
      purpose: "memory-maintenance",
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        agentId: "ada",
      }),
    );
    expect(result.agentId).toBe("ada");
    expect(result.audit).toMatchObject({
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
    });
    expect(result.parsed).toEqual({ summary: "ok" });
  });

  it("uses trusted context-engine attribution inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await withPluginRuntimePluginIdScope("memory-core", () =>
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
        purpose: "memory-maintenance",
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.after-turn",
    });
    expect(result.agentId).toBe("ada");
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

  it("fails closed for context-engine completions without any session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
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
        model: "openai-codex/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("allows context-engine model overrides through the owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai-codex/gpt-5.4-mini", "minimax/MiniMax-M2.7"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openai-codex/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        modelRef: "openai-codex/gpt-5.4-mini",
      }),
    );
    expect(result.audit).toMatchObject({
      caller: { kind: "context-engine", id: "context-engine.compaction" },
      sessionKey: "agent:main:session:abc",
    });
  });

  it("denies context-engine model overrides outside the owning plugin allowlist", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai-codex/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai-codex/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow(
      'model override "openai-codex/gpt-5.5" is not allowlisted for plugin "lossless-claw"',
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("keeps context-engine attribution and host-derived policy inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai-codex/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await withPluginRuntimePluginIdScope("spoofed-plugin", () =>
      runtimeContext.llm!.complete({
        model: "openai-codex/gpt-5.4-mini",
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
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "openai-codex/gpt-5.4-mini",
      }),
    );
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
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
      }),
    );

    await expect(
      runtimeContext.llm!.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the active session agent");
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
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "openai/gpt-5.4",
      }),
    );

    await expect(
      llm.complete({
        model: "openai/gpt-5.6",
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow('model override "openai/gpt-5.6" is not allowlisted');
  });

  it("uses runtime-scoped config and the host preparation/dispatch path", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
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
      purpose: "test-purpose",
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
        caller: { kind: "host", id: "runtime-test" },
        purpose: "test-purpose",
        usage: expect.objectContaining({ costUsd: 0.0042 }),
      }),
    );
  });

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        caller: { kind: "host", id: "ignored-host" },
        allowComplete: true,
      },
    });

    const result = await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expect(logger.info).toHaveBeenCalledWith(
      "plugin llm completion",
      expect.objectContaining({
        caller: { kind: "plugin", id: "trusted-plugin" },
        purpose: "identity-test",
      }),
    );
  });

  it("denies plugin model overrides by default", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        denied.complete({
          agentId: "worker",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    const allowed = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowAgentIdOverride: true,
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      allowed.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
      }),
    );
  });

  it("allows plugin model overrides only when configured and allowlisted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        modelRef: "openai/gpt-5.4",
      }),
    );

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.6",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow('model override "openai/gpt-5.6" is not allowlisted');
  });

  it("rejects auth-profile suffixes on complete without explicit trust", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowModelOverride: true,
      },
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.5@openai-codex:work",
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow("cannot override the auth profile");
  });

  it("treats same-as-default auth-profile suffixes on complete as profile-only overrides", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowProfileOverride: true,
      },
    });

    await llm.complete({
      model: "openai/gpt-5.5@openai-codex:work",
      messages: [{ role: "user", content: "Ping" }],
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: undefined,
        preferredProfile: "openai-codex:work",
      }),
    );
  });

  it("returns parsed structured JSON for text-only completion and validates the schema", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: '```json\n{"summary":"ok"}\n```' }],
      usage: {
        input: 4,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        total: 7,
        cost: { total: 0.001 },
      },
    });

    const result = await llm.completeStructured({
      instructions: "Extract a short summary.",
      input: [{ type: "text", text: "Customer said the rollout worked." }],
      schemaName: "support.summary",
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      systemPrompt: "Be precise.",
      purpose: "structured.summary",
    });

    expect(result).toMatchObject({
      text: '```json\n{"summary":"ok"}\n```',
      parsed: { summary: "ok" },
      contentType: "json",
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(hoisted.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          systemPrompt: "Be precise.",
          messages: [
            expect.objectContaining({
              role: "user",
              content: [
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining("Schema name: support.summary"),
                }),
                expect.objectContaining({
                  type: "text",
                  text: "Customer said the rollout worked.",
                }),
              ],
            }),
          ],
        }),
      }),
    );
  });

  it("supports image-plus-text structured completion with the host-owned llm runtime", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce(
      createPreparedModel("gpt-5.5", ["text", "image"]),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"caption":"receipt","tags":["finance"]}' }],
      usage: {
        input: 10,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        total: 16,
        cost: { total: 0.002 },
      },
    });

    const result = await llm.completeStructured({
      instructions: "Extract searchable receipt metadata.",
      input: [
        {
          type: "image",
          buffer: Buffer.from("hello"),
          mimeType: "image/png",
          fileName: "receipt.png",
        },
        { type: "text", text: "Prefer the printed total over handwritten notes." },
      ],
      jsonMode: true,
    });

    expect(result.parsed).toEqual({ caption: "receipt", tags: ["finance"] });
    expect(hoisted.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.from("hello").toString("base64"),
                }),
                expect.objectContaining({
                  type: "text",
                  text: "Prefer the printed total over handwritten notes.",
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it("rejects structured auth-profile overrides without explicit trust", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });

    await expect(
      llm.completeStructured({
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        profile: "openai-codex:work",
        jsonMode: false,
      }),
    ).rejects.toThrow("cannot override the auth profile");
  });

  it("forwards preferred auth profiles into structured completion prep when trusted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowProfileOverride: true,
      },
    });

    await llm.completeStructured({
      instructions: "Extract summary.",
      input: [{ type: "text", text: "Hello" }],
      profile: "openai-codex:work",
      jsonMode: false,
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProfile: "openai-codex:work",
      }),
    );
  });

  it("rejects auth-profile suffixes in structured model refs without explicit trust", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowModelOverride: true,
      },
    });

    await expect(
      llm.completeStructured({
        model: "openai/gpt-5.5@openai-codex:work",
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        jsonMode: false,
      }),
    ).rejects.toThrow("cannot override the auth profile");
  });

  it("treats same-as-default auth-profile suffixes in structured model refs as profile-only overrides when trusted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowProfileOverride: true,
      },
    });

    await llm.completeStructured({
      model: "openai/gpt-5.5@openai-codex:work",
      instructions: "Extract summary.",
      input: [{ type: "text", text: "Hello" }],
      jsonMode: false,
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: undefined,
        preferredProfile: "openai-codex:work",
      }),
    );
  });

  it("allows same-as-default auth-profile suffixes through plugin llm policy", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowProfileOverride: true,
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.completeStructured({
        model: "openai/gpt-5.5@openai-codex:work",
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        jsonMode: false,
      }),
    );

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: undefined,
        preferredProfile: "openai-codex:work",
      }),
    );
  });

  it("requires both model and profile trust when the structured model ref changes the target model", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
        allowProfileOverride: true,
      },
    });

    await llm.completeStructured({
      model: "openai/gpt-5.4@openai-codex:work",
      instructions: "Extract summary.",
      input: [{ type: "text", text: "Hello" }],
      jsonMode: false,
    });

    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "openai/gpt-5.4",
        preferredProfile: "openai-codex:work",
      }),
    );
  });

  it("rejects conflicting explicit and embedded structured auth-profile overrides", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
        allowModelOverride: true,
        allowProfileOverride: true,
      },
    });

    await expect(
      llm.completeStructured({
        model: "openai/gpt-5.5@openai-codex:work",
        profile: "openai-codex:other",
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        jsonMode: false,
      }),
    ).rejects.toThrow("conflicting auth profiles");
  });

  it("falls back to the configured image model for structured image input", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.resolveAutoImageModel.mockResolvedValueOnce({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
    });
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce(
      createPreparedModel("gemini-3.1-flash-image-preview", ["text", "image"]),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"summary":"ok"}' }],
      usage: {
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 4,
        cost: { total: 0.001 },
      },
    });

    const result = await llm.completeStructured({
      instructions: "Extract receipt fields.",
      input: [{ type: "image", buffer: Buffer.from("hello"), mimeType: "image/png" }],
      jsonMode: true,
    });

    expect(result.parsed).toEqual({ summary: "ok" });
    expect(hoisted.resolveAutoImageModel).toHaveBeenCalledWith(expect.objectContaining({ cfg }));
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "google/gemini-3.1-flash-image-preview",
      }),
    );
  });

  it("rejects structured image input when neither the active nor fallback image model supports images", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.resolveAutoImageModel.mockResolvedValueOnce(null);

    await expect(
      llm.completeStructured({
        instructions: "Extract receipt fields.",
        input: [{ type: "image", buffer: Buffer.from("hello"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("does not support image input");
  });

  it("returns controlled errors for invalid structured JSON", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
      usage: {
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 4,
        cost: { total: 0.001 },
      },
    });

    await expect(
      llm.completeStructured({
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        jsonMode: true,
      }),
    ).rejects.toThrow("returned invalid JSON");
  });

  it("aborts structured completions when timeoutMs elapses", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });
    hoisted.completeWithPreparedSimpleCompletionModel.mockImplementationOnce(
      async ({ options }: { options?: { signal?: AbortSignal } }) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );

    await expect(
      llm.completeStructured({
        instructions: "Extract summary.",
        input: [{ type: "text", text: "Hello" }],
        jsonMode: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out");
  });

  it("applies the same model-override trust rules to structured completion", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.completeStructured({
          model: "openai/gpt-5.4",
          instructions: "Extract summary.",
          input: [{ type: "text", text: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target model");
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
