import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import {
  addTestHook,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-fixtures.js";

const event = { cleanedBody: "hello world" };
describe("before_agent_reply", () => {
  it("rejects revoked handler authority before accepting a claim", async () => {
    let current = true;
    let invocation: PluginHookAgentContext["hookInvocation"];
    const first = vi.fn(async (_event: unknown, ctx: PluginHookAgentContext) => {
      invocation = ctx.hookInvocation;
      expect(invocation).toBeDefined();
      invocation?.assertActive();
      current = false;
      expect(invocation?.assertActive).toThrow("root reassigned");
      return { handled: true, reply: { text: "stale result" } };
    });
    const nextEffect = vi.fn();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: first },
        { hookName: "before_agent_reply", handler: nextEffect },
      ]),
    );
    const context = withClaimingHookAdmission(
      { ...TEST_PLUGIN_AGENT_CTX },
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error("root reassigned");
          }
        },
      },
    );

    await expect(runner.runBeforeAgentReply(event, context)).rejects.toThrow("root reassigned");
    expect(first).toHaveBeenCalledOnce();
    expect(nextEffect).not.toHaveBeenCalled();
    expect(invocation?.assertActive).toThrow("no longer active");
    expect(context).not.toHaveProperty("hookInvocation");
  });

  it("closes a timed-out reply invocation before its handler settles", async () => {
    vi.useFakeTimers();
    const release = createDeferredCore<{ handled: boolean }>();
    let invocation: PluginHookAgentContext["hookInvocation"];
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "test-plugin",
      hookName: "before_agent_reply",
      timeoutMs: 5,
      handler: (_event: unknown, ctx: PluginHookAgentContext) => {
        invocation = ctx.hookInvocation;
        return release.promise;
      },
    });
    const runner = createHookRunner(registry, { logger: { error: vi.fn(), warn: vi.fn() } });
    try {
      const work = runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(6);
      await expect(work).resolves.toBeUndefined();
      expect(invocation?.assertActive).toThrow("no longer active");
    } finally {
      release.resolve({ handled: true });
      vi.useRealTimers();
    }
  });

  it("continues past failures and decliners, then stops at the first claim", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const decliner = vi.fn();
    const claimer = vi.fn(() => ({ handled: true, reply: { text: "first" }, reason: "claim" }));
    const skipped = vi.fn(() => ({ handled: true, reply: { text: "second" } }));
    const runner = createHookRunner(
      createMockPluginRegistry(
        [failing, decliner, claimer, skipped].map((handler) => ({
          hookName: "before_agent_reply",
          handler,
        })),
      ),
      { logger },
    );
    await expect(runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX)).resolves.toEqual({
      handled: true,
      reply: { text: "first" },
      reason: "claim",
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed: boom"));
    expect(decliner).toHaveBeenCalledOnce();
    expect(claimer).toHaveBeenCalledExactlyOnceWith(
      event,
      expect.objectContaining(TEST_PLUGIN_AGENT_CTX),
    );
    expect(skipped).not.toHaveBeenCalled();
  });

  it("requires an eligible trigger before invoking a scoped hook", async () => {
    const handler = vi.fn(() => ({ handled: true }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler, eligibleTriggers: ["heartbeat", "cron"] },
      ]),
    );
    expect(runner.hasHooks("before_agent_reply")).toBe(true);
    expect(runner.hasHooks("before_agent_reply", { trigger: "user" })).toBe(false);
    expect(runner.hasHooks("before_agent_reply", { trigger: "cron" })).toBe(true);
    await expect(runner.runBeforeAgentReply(event, TEST_PLUGIN_AGENT_CTX)).resolves.toBeUndefined();
    await expect(runner.runBeforeAgentReply(event, { trigger: "user" })).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    await expect(runner.runBeforeAgentReply(event, { trigger: "cron" })).resolves.toEqual({
      handled: true,
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});
