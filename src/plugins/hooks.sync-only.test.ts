import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  createHookRunner,
  type HookRunnerLogger,
  type PluginHookToolResultBeforeModelContext,
} from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

function createToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function createLogger(): HookRunnerLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  return {
    warn,
    error,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("sync-only plugin hooks", () => {
  it("warns and ignores accidental async tool_result_persist handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const replacementMessage = createToolResultMessage("replacement");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          pluginId: "async-tool-result",
          handler: async () => ({ message: replacementMessage }),
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultPersist(
      { message: originalMessage },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toEqual({ message: originalMessage });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_persist handler from async-tool-result returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("warns and ignores accidental async before_message_write handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          pluginId: "async-before-write",
          handler: async () => ({ block: true }),
        },
      ]),
      { logger },
    );

    const result = runner.runBeforeMessageWrite(
      { message: originalMessage, sessionKey: "session-1", agentId: "agent-1" },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "before_message_write handler from async-before-write returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("warns and ignores accidental async tool_result_before_model handlers", () => {
    const logger = createLogger();
    const originalText = "original";
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "async-before-model",
          handler: async () => ({ text: "replacement" }),
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultBeforeModel(
      { toolName: "read", toolCallId: "call_1", text: originalText },
      {
        agentId: "agent-1",
        sessionKey: "session-1",
        sessionId: "session-1-id",
        runId: "run-1",
        toolName: "read",
        toolCallId: "call_1",
      },
    );

    expect(result).toEqual({ text: originalText });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_before_model handler from async-before-model returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not leak pre-await context mutations from async tool_result_before_model handlers", () => {
    const logger = createLogger();
    const originalText = "original";
    let seenRunId: string | undefined;
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "async-before-model-mutate",
          handler: async (_event, ctx) => {
            const hookCtx = ctx as PluginHookToolResultBeforeModelContext;
            hookCtx.runId = "mutated-run-id";
            await Promise.resolve();
            return undefined;
          },
        },
        {
          hookName: "tool_result_before_model",
          pluginId: "ctx-observer",
          handler: (_event, ctx) => {
            seenRunId = (ctx as PluginHookToolResultBeforeModelContext).runId;
            return undefined;
          },
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultBeforeModel(
      { toolName: "read", toolCallId: "call_1", text: originalText },
      {
        agentId: "agent-1",
        sessionKey: "session-1",
        sessionId: "session-1-id",
        runId: "run-1",
        toolName: "read",
        toolCallId: "call_1",
      },
    );

    expect(result).toEqual({ text: originalText });
    expect(seenRunId).toBe("run-1");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_before_model handler from async-before-model-mutate returned a Promise",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("observes later rejections from ignored async tool_result_before_model handlers", async () => {
    const logger = createLogger();
    const originalText = "original";
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_before_model",
          pluginId: "async-before-model-reject",
          handler: async () => {
            await Promise.resolve();
            throw new Error("later boom");
          },
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultBeforeModel(
      { toolName: "read", toolCallId: "call_1", text: originalText },
      {
        agentId: "agent-1",
        sessionKey: "session-1",
        sessionId: "session-1-id",
        runId: "run-1",
        toolName: "read",
        toolCallId: "call_1",
      },
    );

    expect(result).toEqual({ text: originalText });
    await flushMicrotasks();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_before_model handler from async-before-model-reject returned a Promise",
      ),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tool_result_before_model handler from async-before-model-reject returned a Promise and later rejected: Error: later boom",
      ),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
