import { describe, expect, it, vi } from "vitest";
import { normalizeHookEligibleAgentIds } from "./hook-eligibility.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const scopedCtx = (sessionKey?: string) => ({
  channelId: "telegram",
  accountId: "default",
  conversationId: "-100123",
  ...(sessionKey ? { sessionKey } : {}),
});

function createScopedRunner(eligibleAgentIds?: readonly string[]) {
  const registry = createEmptyPluginRegistry();
  const messageSending = vi.fn(() => ({ content: "rewritten" }));
  const replyPayloadSending = vi.fn(() => ({ cancel: true }));
  addTestHook({
    registry,
    pluginId: "policy",
    hookName: "message_sending",
    handler: messageSending,
    ...(eligibleAgentIds ? { eligibleAgentIds } : {}),
  });
  addTestHook({
    registry,
    pluginId: "policy",
    hookName: "reply_payload_sending",
    handler: replyPayloadSending,
    ...(eligibleAgentIds ? { eligibleAgentIds } : {}),
  });
  return { runner: createHookRunner(registry), messageSending, replyPayloadSending };
}

describe("eligibleAgentIds for outbound send hooks", () => {
  it("normalizes valid lists and leaves omitted or malformed lists unrestricted", () => {
    expect(normalizeHookEligibleAgentIds([" Support ", "support", "ops_1"])).toEqual([
      "support",
      "ops_1",
    ]);
    for (const value of [undefined, [], "support", ["support", ""], ["support", 7], ["a b"]]) {
      expect(normalizeHookEligibleAgentIds(value)).toBeUndefined();
    }
  });

  it("hides scoped hooks only from turns whose session key proves another agent", () => {
    const { runner } = createScopedRunner(["support"]);
    for (const hookName of ["message_sending", "reply_payload_sending"] as const) {
      expect(runner.hasHooks(hookName)).toBe(true);
      expect(runner.hasHooks(hookName, scopedCtx())).toBe(true);
      expect(runner.hasHooks(hookName, scopedCtx("telegram:direct:42"))).toBe(true);
      expect(runner.hasHooks(hookName, scopedCtx("agent:support:telegram:group:-100123"))).toBe(
        true,
      );
      expect(runner.hasHooks(hookName, scopedCtx("agent:Support:telegram:group:-100123"))).toBe(
        true,
      );
      expect(runner.hasHooks(hookName, scopedCtx("agent:main:telegram:direct:42"))).toBe(false);
    }
  });

  it("applies the same scope when dispatching, so presence and execution agree", async () => {
    const { runner, messageSending, replyPayloadSending } = createScopedRunner(["support"]);
    const payloadEvent = { payload: { text: "draft" }, kind: "final" as const };

    await expect(
      runner.runMessageSending(
        { to: "42", content: "hello" },
        scopedCtx("agent:main:telegram:direct:42"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      runner.runReplyPayloadSending(payloadEvent, scopedCtx("agent:main:telegram:direct:42")),
    ).resolves.toBeUndefined();
    expect(messageSending).not.toHaveBeenCalled();
    expect(replyPayloadSending).not.toHaveBeenCalled();

    await expect(
      runner.runMessageSending(
        { to: "-100123", content: "hello" },
        scopedCtx("agent:support:telegram:group:-100123"),
      ),
    ).resolves.toMatchObject({ content: "rewritten" });
    await expect(
      runner.runMessageSending({ to: "-100123", content: "hello" }, scopedCtx()),
    ).resolves.toMatchObject({ content: "rewritten" });
    await expect(runner.runReplyPayloadSending(payloadEvent, scopedCtx())).resolves.toMatchObject({
      cancel: true,
    });
    expect(messageSending).toHaveBeenCalledTimes(2);
    expect(replyPayloadSending).toHaveBeenCalledOnce();
  });

  it("keeps unscoped send hooks global", async () => {
    const { runner, messageSending } = createScopedRunner();
    const ctx = scopedCtx("agent:main:telegram:direct:42");
    expect(runner.hasHooks("message_sending", ctx)).toBe(true);
    expect(runner.hasHooks("reply_payload_sending", ctx)).toBe(true);
    await expect(
      runner.runMessageSending({ to: "42", content: "hello" }, ctx),
    ).resolves.toMatchObject({ content: "rewritten" });
    expect(messageSending).toHaveBeenCalledOnce();
  });
});
