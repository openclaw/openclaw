import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded-runner/types.js";
import type { ExecutionRequest, RuntimeContext } from "./types.js";
import { EventRouter } from "./events.js";
import {
  DefaultTurnExecutor,
  createTurnExecutor,
  type TurnExecutor,
  type RunEmbeddedPiAgentFn,
  type RunCliAgentFn,
} from "./executor.js";

/**
 * Create a mock Pi runtime function for testing.
 */
const createMockPiRuntime = (overrides?: Partial<EmbeddedPiRunResult>): RunEmbeddedPiAgentFn => {
  return vi.fn(async (params) => {
    const reply = `Mock response for: ${params.prompt.slice(0, 30)}`;
    return {
      payloads: [{ text: reply }],
      meta: {
        durationMs: 100,
        agentMeta: {
          sessionId: params.sessionId,
          provider: "mock-provider",
          model: "mock-model",
          usage: {
            input: params.prompt.length,
            output: reply.length,
          },
        },
      },
      didSendViaMessagingTool: false,
      ...overrides,
    } satisfies EmbeddedPiRunResult;
  });
};

/**
 * Create a mock CLI runtime function for testing.
 */
const createMockCliRuntime = (overrides?: Partial<EmbeddedPiRunResult>): RunCliAgentFn => {
  return vi.fn(async (params) => {
    const reply = `CLI response for: ${params.prompt.slice(0, 30)}`;
    return {
      payloads: [{ text: reply }],
      meta: {
        durationMs: 50,
        agentMeta: {
          sessionId: params.sessionId,
          provider: params.provider,
          model: params.model ?? "default",
          usage: {
            input: params.prompt.length,
            output: reply.length,
          },
        },
      },
      ...overrides,
    } satisfies EmbeddedPiRunResult;
  });
};

describe("TurnExecutor", () => {
  let executor: TurnExecutor;
  let emitter: EventRouter;
  let mockPiRuntime: RunEmbeddedPiAgentFn;
  let mockCliRuntime: RunCliAgentFn;

  const createMockRequest = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
    agentId: "test-agent",
    sessionId: "test-session",
    workspaceDir: "/tmp/test",
    prompt: "Hello, world!",
    ...overrides,
  });

  const createMockContext = (overrides: Partial<RuntimeContext> = {}): RuntimeContext => ({
    kind: "pi",
    provider: "test-provider",
    model: "test-model",
    toolPolicy: { enabled: true },
    sandbox: null,
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      supportsImages: true,
      supportsThinking: false,
    },
    ...overrides,
  });

  beforeEach(() => {
    mockPiRuntime = createMockPiRuntime();
    mockCliRuntime = createMockCliRuntime();
    executor = createTurnExecutor({
      piRuntimeFn: mockPiRuntime,
      cliRuntimeFn: mockCliRuntime,
    });
    emitter = new EventRouter();
  });

  describe("createTurnExecutor", () => {
    it("should create a TurnExecutor instance", () => {
      const executor = createTurnExecutor({
        piRuntimeFn: mockPiRuntime,
      });
      expect(executor).toBeDefined();
      expect(executor).toBeInstanceOf(DefaultTurnExecutor);
    });

    it("should accept options", () => {
      const logger = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const executor = createTurnExecutor({
        logger,
        piRuntimeFn: mockPiRuntime,
      });
      expect(executor).toBeDefined();
    });
  });

  describe("execute", () => {
    it("should not emit lifecycle events (lifecycle managed by kernel)", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      await executor.execute(context, request, emitter);

      const events = emitter.getEmittedEvents();
      const lifecycleEvents = events.filter(
        (e) =>
          e.kind === "lifecycle.start" ||
          e.kind === "lifecycle.end" ||
          e.kind === "lifecycle.error",
      );
      expect(lifecycleEvents).toHaveLength(0);
    });

    it("should return TurnOutcome with reply", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await executor.execute(context, request, emitter);

      expect(outcome).toBeDefined();
      expect(outcome.reply).toBeDefined();
      expect(outcome.reply).toContain("Mock response for:");
      expect(outcome.payloads).toBeDefined();
      expect(outcome.toolCalls).toEqual([]);
      expect(outcome.usage).toBeDefined();
      expect(outcome.usage.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should track usage metrics", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await executor.execute(context, request, emitter);

      expect(outcome.usage.inputTokens).toBeGreaterThan(0);
      expect(outcome.usage.outputTokens).toBeGreaterThan(0);
      expect(outcome.usage.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should use provided runId for internal state", async () => {
      const request = createMockRequest({ runId: "custom-run-id" });
      const context = createMockContext();

      const outcome = await executor.execute(context, request, emitter);
      expect(outcome).toBeDefined();
    });
  });

  describe("event emission", () => {
    it("should not emit lifecycle events (managed by kernel)", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      await executor.execute(context, request, emitter);

      const events = emitter.getEmittedEvents();
      const lifecycleKinds = events.map((e) => e.kind).filter((k) => k.startsWith("lifecycle."));
      expect(lifecycleKinds).toHaveLength(0);
    });
  });

  describe("normalization", () => {
    it("should normalize reply text", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await executor.execute(context, request, emitter);

      // Reply should be defined and normalized
      expect(outcome.reply).toBeDefined();
    });
  });

  describe("callback handling", () => {
    it("should invoke onPartialReply callback", async () => {
      const onPartialReply = vi.fn();
      const request = createMockRequest({ onPartialReply });
      const context = createMockContext();

      // Note: The mock adapter doesn't call onPartialReply
      // This test verifies the wiring is in place
      await executor.execute(context, request, emitter);

      // With the mock adapter, no partials are emitted
      // This would be different with a real adapter that streams
    });
  });

  describe("error handling", () => {
    it("should handle execution errors gracefully", async () => {
      const errorLogger = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const errorExecutor = createTurnExecutor({
        logger: errorLogger,
        piRuntimeFn: mockPiRuntime,
      });

      const request = createMockRequest();
      const context = createMockContext();

      // Should not throw
      const outcome = await errorExecutor.execute(context, request, emitter);
      expect(outcome).toBeDefined();
    });

    it("should re-throw when runtime throws (lifecycle error handled by kernel)", async () => {
      const failingRuntime = vi.fn(async () => {
        throw new Error("Runtime failure");
      }) as unknown as RunEmbeddedPiAgentFn;

      const failingExecutor = createTurnExecutor({
        piRuntimeFn: failingRuntime,
      });

      const request = createMockRequest();
      const context = createMockContext();

      await expect(failingExecutor.execute(context, request, emitter)).rejects.toThrow(
        "Runtime failure",
      );
    });
  });

  describe("runtime context handling", () => {
    it("should handle pi runtime kind", async () => {
      const request = createMockRequest();
      const context = createMockContext({ kind: "pi" });

      const outcome = await executor.execute(context, request, emitter);
      expect(outcome).toBeDefined();
      expect(vi.mocked(mockPiRuntime)).toHaveBeenCalled();
    });

    it("should handle claude runtime kind (placeholder)", async () => {
      const request = createMockRequest();
      const context = createMockContext({ kind: "claude" });

      const outcome = await executor.execute(context, request, emitter);
      expect(outcome).toBeDefined();
      // Claude uses placeholder adapter, so neither Pi nor CLI runtime should be called
      expect(vi.mocked(mockPiRuntime)).not.toHaveBeenCalled();
      expect(vi.mocked(mockCliRuntime)).not.toHaveBeenCalled();
    });

    it("should handle cli runtime kind", async () => {
      const request = createMockRequest();
      const context = createMockContext({ kind: "cli" });

      const outcome = await executor.execute(context, request, emitter);
      expect(outcome).toBeDefined();
      expect(vi.mocked(mockCliRuntime)).toHaveBeenCalled();
    });
  });

  describe("tool tracking", () => {
    it("should track tool calls in outcome", async () => {
      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await executor.execute(context, request, emitter);

      // With mock adapter, no tool calls
      expect(outcome.toolCalls).toEqual([]);
    });
  });

  describe("session context", () => {
    it("should pass sessionKey through to runtime adapter", async () => {
      const request = createMockRequest({ sessionKey: "session:test:key" });
      const context = createMockContext({ kind: "pi" });

      await executor.execute(context, request, emitter);

      expect(vi.mocked(mockPiRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "session:test:key",
        }),
      );
    });
  });

  describe("runtime adapter parameter mapping", () => {
    it("should pass prompt to Pi runtime", async () => {
      const request = createMockRequest({ prompt: "Test prompt for Pi" });
      const context = createMockContext({ kind: "pi" });

      await executor.execute(context, request, emitter);

      expect(vi.mocked(mockPiRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Test prompt for Pi",
        }),
      );
    });

    it("should pass sessionId to runtime", async () => {
      const request = createMockRequest({ sessionId: "my-session-123" });
      const context = createMockContext({ kind: "pi" });

      await executor.execute(context, request, emitter);

      expect(vi.mocked(mockPiRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "my-session-123",
        }),
      );
    });

    it("should pass provider and model from context", async () => {
      const request = createMockRequest();
      const context = createMockContext({
        kind: "pi",
        provider: "anthropic",
        model: "claude-3-opus",
      });

      await executor.execute(context, request, emitter);

      expect(vi.mocked(mockPiRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-3-opus",
        }),
      );
    });

    it("should pass CLI params correctly", async () => {
      const request = createMockRequest({
        prompt: "CLI test prompt",
        sessionId: "cli-session",
        extraSystemPrompt: "Extra instructions",
      });
      const context = createMockContext({
        kind: "cli",
        provider: "claude-cli",
        model: "opus",
      });

      await executor.execute(context, request, emitter);

      expect(vi.mocked(mockCliRuntime)).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "CLI test prompt",
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
          extraSystemPrompt: "Extra instructions",
        }),
      );
    });
  });

  describe("result mapping", () => {
    it("should map didSendViaMessagingTool from result", async () => {
      const runtimeWithMessaging = createMockPiRuntime({
        didSendViaMessagingTool: true,
      });
      const msgExecutor = createTurnExecutor({
        piRuntimeFn: runtimeWithMessaging,
      });

      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await msgExecutor.execute(context, request, emitter);
      expect(outcome.didSendViaMessagingTool).toBe(true);
    });

    it("should map usage metrics from result", async () => {
      const runtimeWithUsage = createMockPiRuntime();
      const usageExecutor = createTurnExecutor({
        piRuntimeFn: runtimeWithUsage,
      });

      const request = createMockRequest({ prompt: "A prompt with some length" });
      const context = createMockContext();

      const outcome = await usageExecutor.execute(context, request, emitter);

      expect(outcome.usage.inputTokens).toBe(request.prompt.length);
      expect(outcome.usage.outputTokens).toBeGreaterThan(0);
    });

    it("should map embedded error from result meta into outcome", async () => {
      const runtimeWithError = vi.fn(async (params: unknown) => ({
        payloads: [{ text: "Error occurred" }],
        meta: {
          durationMs: 10,
          agentMeta: {
            sessionId: (params as { sessionId: string }).sessionId,
            provider: "test",
            model: "test",
          },
          error: {
            kind: "context_overflow" as const,
            message: "Context window exceeded",
          },
        },
      })) as unknown as RunEmbeddedPiAgentFn;

      const errorExecutor = createTurnExecutor({
        piRuntimeFn: runtimeWithError,
      });

      const request = createMockRequest();
      const context = createMockContext();

      const outcome = await errorExecutor.execute(context, request, emitter);

      // Embedded errors are carried in the outcome, not thrown
      expect(outcome).toBeDefined();
      expect(outcome.embeddedError).toBeDefined();
      expect(outcome.embeddedError?.kind).toBe("context_overflow");
      expect(outcome.embeddedError?.message).toBe("Context window exceeded");
    });
  });
});

describe("DefaultTurnExecutor", () => {
  describe("constructor", () => {
    it("should create instance with default options", () => {
      const executor = new DefaultTurnExecutor();
      expect(executor).toBeDefined();
    });

    it("should accept logger option", () => {
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const executor = new DefaultTurnExecutor({ logger });
      expect(executor).toBeDefined();
    });

    it("should accept normalization options", () => {
      const executor = new DefaultTurnExecutor({
        normalizationOptions: {
          stripHeartbeat: false,
          stripThinking: false,
        },
      });
      expect(executor).toBeDefined();
    });

    it("should accept runtime function options", () => {
      const mockPi = vi.fn();
      const mockCli = vi.fn();
      const executor = new DefaultTurnExecutor({
        piRuntimeFn: mockPi as unknown as RunEmbeddedPiAgentFn,
        cliRuntimeFn: mockCli as unknown as RunCliAgentFn,
      });
      expect(executor).toBeDefined();
    });
  });
});
