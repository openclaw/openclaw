/**
 * Layer 1: Hook Merger Tests for before_agent_reply
 *
 * Validates that the before_agent_reply hook correctly short-circuits agent
 * processing by returning a synthetic ReplyPayload, with proper priority
 * ordering and error handling.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookBeforeAgentReplyResult, PluginHookRegistration } from "./types.js";

function addBeforeAgentReplyHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookBeforeAgentReplyResult | Promise<PluginHookBeforeAgentReplyResult>,
  priority?: number,
) {
  registry.typedHooks.push({
    pluginId,
    hookName: "before_agent_reply",
    handler,
    priority,
    source: "test",
  } as PluginHookRegistration);
}

const stubCtx = {
  agentId: "test-agent",
  sessionKey: "sk",
  sessionId: "sid",
  workspaceDir: "/tmp",
};

describe("before_agent_reply hook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("returns reply from a single plugin", async () => {
    addBeforeAgentReplyHook(registry, "dialog-plugin", () => ({
      reply: { text: "Please enter your name:" },
      reason: "dialog active",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    expect(result?.reply).toEqual({ text: "Please enter your name:" });
    expect(result?.reason).toBe("dialog active");
  });

  it("returns undefined when hook returns nothing", async () => {
    addBeforeAgentReplyHook(registry, "inactive-plugin", () => ({}));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    // Handler returned {}, which has no reply field — should pass through
    expect(result?.reply).toBeUndefined();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    expect(result).toBeUndefined();
  });

  it("higher-priority plugin's reply wins", async () => {
    addBeforeAgentReplyHook(
      registry,
      "low-priority",
      () => ({ reply: { text: "low" }, reason: "low" }),
      1,
    );
    addBeforeAgentReplyHook(
      registry,
      "high-priority",
      () => ({ reply: { text: "high" }, reason: "high" }),
      10,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    // High-priority runs first, its reply sticks via acc?.reply ?? next.reply
    expect(result?.reply).toEqual({ text: "high" });
    expect(result?.reason).toBe("high");
  });

  it("lower-priority plugin reply is ignored when higher-priority already provided one", async () => {
    addBeforeAgentReplyHook(
      registry,
      "high-priority",
      () => ({ reply: { text: "intercepted" } }),
      10,
    );
    addBeforeAgentReplyHook(
      registry,
      "low-priority",
      () => ({ reply: { text: "should be ignored" } }),
      1,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    expect(result?.reply).toEqual({ text: "intercepted" });
  });

  it("lower-priority plugin can provide reply when higher-priority returns nothing", async () => {
    addBeforeAgentReplyHook(registry, "high-priority", () => ({}), 10);
    addBeforeAgentReplyHook(
      registry,
      "low-priority",
      () => ({ reply: { text: "fallback" }, reason: "low caught it" }),
      1,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    expect(result?.reply).toEqual({ text: "fallback" });
    expect(result?.reason).toBe("low caught it");
  });

  it("error in hook is caught with catchErrors: true", async () => {
    addBeforeAgentReplyHook(registry, "bad-plugin", () => {
      throw new Error("plugin crash");
    });

    const errors: string[] = [];
    const runner = createHookRunner(registry, {
      catchErrors: true,
      logger: {
        warn: () => {},
        error: (msg) => errors.push(msg),
      },
    });

    const result = await runner.runBeforeAgentReply({ cleanedBody: "hello" }, stubCtx);

    expect(result).toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("bad-plugin");
  });

  it("hasHooks returns true when before_agent_reply hooks are registered", () => {
    addBeforeAgentReplyHook(registry, "plugin-a", () => ({}));

    const runner = createHookRunner(registry);
    expect(runner.hasHooks("before_agent_reply")).toBe(true);
  });

  it("hasHooks returns false when no before_agent_reply hooks are registered", () => {
    const runner = createHookRunner(registry);
    expect(runner.hasHooks("before_agent_reply")).toBe(false);
  });
});
