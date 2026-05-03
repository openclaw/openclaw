import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookToolContext,
  PluginHookMessageContext,
  PluginHookBeforeToolCallResult,
  PluginHookMessageSendingResult,
  PluginHookBeforeAgentReplyResult,
  PluginHookBeforeMessageWriteResult,
} from "./types.js";

const SYSTEM_PRIORITY = 10000;

const toolCtx: PluginHookToolContext = {
  toolName: "bash",
  agentId: "main",
  sessionKey: "agent:main:main",
};

const messageCtx: PluginHookMessageContext = {
  channelId: "whatsapp",
  conversationId: "user-123",
};

const agentCtx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "sess-1",
  workspaceDir: "/tmp/test",
  messageProvider: "test",
};

describe("system plugin blocking — before_tool_call", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("block=true prevents tool execution and is terminal", async () => {
    const callOrder: string[] = [];
    addTestHook({
      registry,
      pluginId: "system-interceptor",
      hookName: "before_tool_call",
      handler: () => {
        callOrder.push("system");
        return { block: true, blockReason: "blocked by system policy" };
      },
      priority: SYSTEM_PRIORITY,
    });
    addTestHook({
      registry,
      pluginId: "user-plugin",
      hookName: "before_tool_call",
      handler: () => {
        callOrder.push("user");
        return { block: false };
      },
      priority: 50,
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, toolCtx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked by system policy");
    // User plugin handler should never have been called (terminal)
    expect(callOrder).toEqual(["system"]);
  });

  it("system plugin can rewrite tool params", async () => {
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [
        {
          pluginId: "system-interceptor",
          result: { params: { command: "echo safe" } },
          priority: SYSTEM_PRIORITY,
        },
      ],
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(
      { toolName: "bash", params: { command: "rm -rf /" } },
      toolCtx,
    );

    expect(result?.block).toBeUndefined();
    expect(result?.params).toEqual({ command: "echo safe" });
  });

  it("system plugin block overrides lower-priority allow", async () => {
    addStaticTestHooks(registry, {
      hookName: "before_tool_call",
      hooks: [
        {
          pluginId: "system-interceptor",
          result: { block: true, blockReason: "policy" },
          priority: SYSTEM_PRIORITY,
        },
        {
          pluginId: "user-plugin",
          result: { block: false },
          priority: 50,
        },
      ],
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall({ toolName: "bash", params: {} }, toolCtx);

    expect(result?.block).toBe(true);
  });
});

describe("system plugin blocking — message_sending", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("cancel=true drops the message and is terminal", async () => {
    const callOrder: string[] = [];
    addTestHook({
      registry,
      pluginId: "system-dlp",
      hookName: "message_sending",
      handler: () => {
        callOrder.push("system");
        return { cancel: true };
      },
      priority: SYSTEM_PRIORITY,
    });
    addTestHook({
      registry,
      pluginId: "user-plugin",
      hookName: "message_sending",
      handler: () => {
        callOrder.push("user");
        return { cancel: false };
      },
      priority: 50,
    });

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(
      { to: "user-123", content: "secret API key: sk-..." },
      messageCtx,
    );

    expect(result?.cancel).toBe(true);
    // User plugin handler should never have been called (terminal)
    expect(callOrder).toEqual(["system"]);
  });

  it("system plugin can rewrite message content", async () => {
    addStaticTestHooks(registry, {
      hookName: "message_sending",
      hooks: [
        {
          pluginId: "system-dlp",
          result: { content: "[REDACTED]" },
          priority: SYSTEM_PRIORITY,
        },
      ],
    });

    const runner = createHookRunner(registry);
    const result = await runner.runMessageSending(
      { to: "user-123", content: "secret data" },
      messageCtx,
    );

    expect(result?.cancel).toBeUndefined();
    expect(result?.content).toBe("[REDACTED]");
  });
});

describe("system plugin blocking — before_agent_reply", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("handled=true short-circuits the LLM call", async () => {
    addTestHook({
      registry,
      pluginId: "system-gate",
      hookName: "before_agent_reply",
      handler: () => ({
        handled: true,
        reply: { text: "Request denied by system policy." },
      }),
      priority: SYSTEM_PRIORITY,
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply(
      { cleanedBody: "do something dangerous" },
      agentCtx,
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply).toEqual({ text: "Request denied by system policy." });
  });

  it("system claim wins over lower-priority user claim", async () => {
    const callOrder: string[] = [];
    addTestHook({
      registry,
      pluginId: "system-gate",
      hookName: "before_agent_reply",
      handler: () => {
        callOrder.push("system");
        return { handled: true, reply: { text: "system reply" } };
      },
      priority: SYSTEM_PRIORITY,
    });
    addTestHook({
      registry,
      pluginId: "user-plugin",
      hookName: "before_agent_reply",
      handler: () => {
        callOrder.push("user");
        return { handled: true, reply: { text: "user reply" } };
      },
      priority: 50,
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply(
      { cleanedBody: "hello" },
      agentCtx,
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply).toEqual({ text: "system reply" });
    expect(callOrder).toEqual(["system"]);
  });
});

describe("system plugin blocking — before_message_write (transcript suppression)", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("block=true prevents message from being written to transcript", () => {
    addTestHook({
      registry,
      pluginId: "system-audit",
      hookName: "before_message_write",
      handler: () => ({ block: true }),
      priority: SYSTEM_PRIORITY,
    });

    const runner = createHookRunner(registry);
    const message = { role: "assistant", content: "sensitive output" };
    const result = runner.runBeforeMessageWrite(
      { message: message as never },
      { agentId: "main", sessionKey: "agent:main:main" },
    );

    expect(result?.block).toBe(true);
    // When block=true, the caller (session-tool-result-guard) returns null
    // and the message is NOT appended to the session JSONL.
  });

  it("block=true is terminal — lower-priority handlers are skipped", () => {
    const callOrder: string[] = [];
    addTestHook({
      registry,
      pluginId: "system-audit",
      hookName: "before_message_write",
      handler: () => {
        callOrder.push("system");
        return { block: true };
      },
      priority: SYSTEM_PRIORITY,
    });
    addTestHook({
      registry,
      pluginId: "user-plugin",
      hookName: "before_message_write",
      handler: () => {
        callOrder.push("user");
        return {};
      },
      priority: 50,
    });

    const runner = createHookRunner(registry);
    runner.runBeforeMessageWrite(
      { message: { role: "assistant", content: "test" } as never },
      { agentId: "main", sessionKey: "agent:main:main" },
    );

    expect(callOrder).toEqual(["system"]);
  });
});
