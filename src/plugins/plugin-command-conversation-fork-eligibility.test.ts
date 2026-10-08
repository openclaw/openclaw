import { describe, expect, it } from "vitest";
import { createPluginCommandConversationForkHost } from "./plugin-command-conversation-fork.js";

describe("plugin fork adapter eligibility", () => {
  it.each(["matrix", "imessage"])("blocks %s before publishing a fork ticket", async (channel) => {
    const host = createPluginCommandConversationForkHost({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:source",
      conversation: { channel, accountId: "default", conversationId: "room-1" },
      signal: new AbortController().signal,
    });
    await expect(host.prepare()).resolves.toEqual({ status: "blocked", reason: "unsupported" });
  });
});
