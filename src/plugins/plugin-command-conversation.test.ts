import { describe, expect, it } from "vitest";
import { createCommandConversationReader } from "./plugin-command-conversation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { isPluginRegistryRetired, markPluginRegistryRetired } from "./registry-lifecycle.js";

describe("command conversation reader", () => {
  it("captures only immutable canonical identity and revokes future reads on invocation close", () => {
    const controller = new AbortController();
    const source = {
      channel: "demo",
      accountId: "a",
      conversationId: "topic",
      parentConversationId: "room",
      extra: "private",
    };
    const read = createCommandConversationReader({
      conversation: source,
      isAuthorizedSender: true,
      signal: controller.signal,
      isRegistryCurrent: () => true,
    });
    source.accountId = "changed";
    const snapshot = read();
    expect(snapshot).toEqual({
      channel: "demo",
      accountId: "a",
      conversationId: "topic",
      parentConversationId: "room",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    controller.abort();
    expect(read()).toBeNull();
    expect(snapshot?.accountId).toBe("a");
  });

  it("rechecks registry currentness after awaited work without revoking captured strings", async () => {
    const registry = createEmptyPluginRegistry();
    const read = createCommandConversationReader({
      conversation: { channel: "demo", accountId: "a", conversationId: "topic" },
      isAuthorizedSender: true,
      signal: new AbortController().signal,
      isRegistryCurrent: () => !isPluginRegistryRetired(registry),
    });
    expect(read()?.conversationId).toBe("topic");
    await Promise.resolve();
    markPluginRegistryRetired(registry);
    expect(read()).toBeNull();
  });

  it.each([
    {
      authorized: false,
      conversation: { channel: "demo", accountId: "a", conversationId: "topic" },
    },
    { authorized: true, conversation: null },
    {
      authorized: true,
      conversation: { channel: "demo", accountId: " a", conversationId: "topic" },
    },
    { authorized: true, conversation: { channel: "demo", accountId: "a", conversationId: "" } },
    {
      authorized: true,
      conversation: {
        channel: "demo",
        accountId: "a",
        conversationId: "topic",
        parentConversationId: " ",
      },
    },
  ])(
    "fails closed for unavailable or unauthorized identity: %j",
    ({ authorized, conversation }) => {
      const read = createCommandConversationReader({
        conversation,
        isAuthorizedSender: authorized,
        signal: new AbortController().signal,
        isRegistryCurrent: () => true,
      });
      expect(read()).toBeNull();
    },
  );
});
