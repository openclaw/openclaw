import { describe, expect, it, vi } from "vitest";
import { withClaimingHookAdmission } from "./hook-claim-admission.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const event = { cleanedBody: "hello world" };
describe("before_agent_reply", () => {
  it("rejects revoked handler authority before accepting a claim", async () => {
    let current = true;
    const first = vi.fn(async () => {
      current = false;
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
    expect(claimer).toHaveBeenCalledExactlyOnceWith(event, TEST_PLUGIN_AGENT_CTX);
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
