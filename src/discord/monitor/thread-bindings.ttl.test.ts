import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const sendMessageDiscord = vi.fn(async (_to: string, _text: string, _opts?: unknown) => ({}));
  const sendWebhookMessageDiscord = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const restGet = vi.fn(async () => ({
    id: "thread-1",
    type: 11,
    parent_id: "parent-1",
  }));
  const restPost = vi.fn(async () => ({
    id: "wh-created",
    token: "tok-created",
  }));
  const createDiscordRestClient = vi.fn((..._args: unknown[]) => ({
    rest: {
      get: restGet,
      post: restPost,
    },
  }));
  const createThreadDiscord = vi.fn(async (..._args: unknown[]) => ({ id: "thread-created" }));
  return {
    sendMessageDiscord,
    sendWebhookMessageDiscord,
    restGet,
    restPost,
    createDiscordRestClient,
    createThreadDiscord,
  };
});

vi.mock("../send.js", () => ({
  sendMessageDiscord: hoisted.sendMessageDiscord,
  sendWebhookMessageDiscord: hoisted.sendWebhookMessageDiscord,
}));

vi.mock("../client.js", () => ({
  createDiscordRestClient: hoisted.createDiscordRestClient,
}));

vi.mock("../send.messages.js", () => ({
  createThreadDiscord: hoisted.createThreadDiscord,
}));

const { __testing, createThreadBindingManager, resolveThreadBindingIntroText } =
  await import("./thread-bindings.js");

describe("thread binding ttl", () => {
  beforeEach(() => {
    __testing.resetThreadBindingsForTests();
    hoisted.sendMessageDiscord.mockClear();
    hoisted.sendWebhookMessageDiscord.mockClear();
    hoisted.restGet.mockClear();
    hoisted.restPost.mockClear();
    hoisted.createDiscordRestClient.mockClear();
    hoisted.createThreadDiscord.mockClear();
    vi.useRealTimers();
  });

  it("includes ttl in intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "main",
      label: "worker",
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });
    expect(intro).toContain("auto-unfocus in 24h");
  });

  it("auto-unfocuses expired bindings and sends a ttl-expired message", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        sessionTtlMs: 60_000,
      });

      const binding = await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
        introText: "intro",
      });
      expect(binding).not.toBeNull();
      hoisted.sendWebhookMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.restGet).not.toHaveBeenCalled();
      expect(hoisted.sendWebhookMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = hoisted.sendWebhookMessageDiscord.mock.calls[0]?.[0] as string | undefined;
      expect(farewell).toContain("Session ended automatically after 1m");
    } finally {
      vi.useRealTimers();
    }
  });
});
