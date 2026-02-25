import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const {
  __testing,
  autoBindSpawnedDiscordSubagent,
  createThreadBindingManager,
  resolveThreadBindingIntroText,
  setThreadBindingTtlBySessionKey,
  unbindThreadBindingsBySessionKey,
} = await import("./thread-bindings.js");

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

  const createDefaultSweeperManager = () =>
    createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: true,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

  const bindDefaultThreadTarget = async (
    manager: ReturnType<typeof createThreadBindingManager>,
  ) => {
    await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
  };

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
      hoisted.sendMessageDiscord.mockClear();
      hoisted.sendWebhookMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.restGet).not.toHaveBeenCalled();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
      expect(hoisted.sendMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = hoisted.sendMessageDiscord.mock.calls[0]?.[1] as string | undefined;
      expect(farewell).toContain("Session ended automatically after 1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when thread sweep probe fails transiently", async () => {
    vi.useFakeTimers();
    try {
      const manager = createDefaultSweeperManager();
      await bindDefaultThreadTarget(manager);

      hoisted.restGet.mockRejectedValueOnce(new Error("ECONNRESET"));

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeDefined();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unbinds when thread sweep probe reports unknown channel", async () => {
    vi.useFakeTimers();
    try {
      const manager = createDefaultSweeperManager();
      await bindDefaultThreadTarget(manager);

      hoisted.restGet.mockRejectedValueOnce({
        status: 404,
        rawError: { code: 10003, message: "Unknown Channel" },
      });

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates ttl by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T23:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
        sessionTtlMs: 24 * 60 * 60 * 1000,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      vi.setSystemTime(new Date("2026-02-20T23:15:00.000Z"));

      const updated = setThreadBindingTtlBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        ttlMs: 2 * 60 * 60 * 1000,
      });

      expect(updated).toHaveLength(1);
      expect(updated[0]?.boundAt).toBe(new Date("2026-02-20T23:15:00.000Z").getTime());
      expect(updated[0]?.expiresAt).toBe(new Date("2026-02-21T01:15:00.000Z").getTime());
      expect(manager.getByThreadId("thread-1")?.expiresAt).toBe(
        new Date("2026-02-21T01:15:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when ttl is disabled per session key", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        sessionTtlMs: 60_000,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });

      const updated = setThreadBindingTtlBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        ttlMs: 0,
      });
      expect(updated).toHaveLength(1);
      expect(updated[0]?.expiresAt).toBe(0);
      hoisted.sendWebhookMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(240_000);

      expect(manager.getByThreadId("thread-1")).toBeDefined();
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses webhook credentials after unbind when rebinding in the same channel", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    const first = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
    });
    expect(first).not.toBeNull();
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);

    manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    const second = await manager.bindTarget({
      threadId: "thread-2",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-2",
      agentId: "main",
    });
    expect(second).not.toBeNull();
    expect(second?.webhookId).toBe("wh-created");
    expect(second?.webhookToken).toBe("tok-created");
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);
  });

  it("creates a new thread when spawning from an already bound thread", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:parent",
      agentId: "main",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-2" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "default",
      channel: "discord",
      to: "channel:thread-1",
      threadId: "thread-1",
      childSessionKey: "agent:main:subagent:child-2",
      agentId: "main",
    });

    expect(childBinding).not.toBeNull();
    expect(hoisted.createThreadDiscord).toHaveBeenCalledTimes(1);
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:parent");
    expect(manager.getByThreadId("thread-created-2")?.targetSessionKey).toBe(
      "agent:main:subagent:child-2",
    );
  });

  it("resolves parent channel when thread target is passed via to without threadId", async () => {
    createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-lookup",
      type: 11,
      parent_id: "parent-1",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-lookup" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "default",
      channel: "discord",
      to: "channel:thread-lookup",
      childSessionKey: "agent:main:subagent:child-lookup",
      agentId: "main",
    });

    expect(childBinding).not.toBeNull();
    expect(childBinding?.channelId).toBe("parent-1");
    expect(hoisted.restGet).toHaveBeenCalledTimes(1);
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("passes manager token when resolving parent channels for auto-bind", async () => {
    createThreadBindingManager({
      accountId: "runtime",
      token: "runtime-token",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    hoisted.createDiscordRestClient.mockClear();
    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-runtime",
      type: 11,
      parent_id: "parent-runtime",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-runtime" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      accountId: "runtime",
      channel: "discord",
      to: "channel:thread-runtime",
      childSessionKey: "agent:main:subagent:child-runtime",
      agentId: "main",
    });

    expect(childBinding).not.toBeNull();
    const firstClientArgs = hoisted.createDiscordRestClient.mock.calls[0]?.[0] as
      | { accountId?: string; token?: string }
      | undefined;
    expect(firstClientArgs).toMatchObject({
      accountId: "runtime",
      token: "runtime-token",
    });
  });

  it("refreshes manager token when an existing manager is reused", async () => {
    createThreadBindingManager({
      accountId: "runtime",
      token: "token-old",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });
    const manager = createThreadBindingManager({
      accountId: "runtime",
      token: "token-new",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-token-refresh" });
    hoisted.createDiscordRestClient.mockClear();

    const bound = await manager.bindTarget({
      createThread: true,
      channelId: "parent-runtime",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:token-refresh",
      agentId: "main",
    });

    expect(bound).not.toBeNull();
    expect(hoisted.createThreadDiscord).toHaveBeenCalledWith(
      "parent-runtime",
      expect.objectContaining({ autoArchiveMinutes: 60 }),
      expect.objectContaining({ accountId: "runtime", token: "token-new" }),
    );
    const usedTokenNew = hoisted.createDiscordRestClient.mock.calls.some(
      (call) => (call?.[0] as { token?: string } | undefined)?.token === "token-new",
    );
    expect(usedTokenNew).toBe(true);
  });

  it("keeps overlapping thread ids isolated per account", async () => {
    const a = createThreadBindingManager({
      accountId: "a",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });
    const b = createThreadBindingManager({
      accountId: "b",
      persist: false,
      enableSweeper: false,
      sessionTtlMs: 24 * 60 * 60 * 1000,
    });

    const aBinding = await a.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:a",
      agentId: "main",
    });
    const bBinding = await b.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:b",
      agentId: "main",
    });

    expect(aBinding?.accountId).toBe("a");
    expect(bBinding?.accountId).toBe("b");
    expect(a.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:a");
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");

    const removedA = a.unbindBySessionKey({
      targetSessionKey: "agent:main:subagent:a",
      sendFarewell: false,
    });
    expect(removedA).toHaveLength(1);
    expect(a.getByThreadId("thread-1")).toBeUndefined();
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");
  });

  it("persists unbinds even when no manager is active", () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      const bindingsPath = __testing.resolveThreadBindingsPath();
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
      const now = Date.now();
      fs.writeFileSync(
        bindingsPath,
        JSON.stringify(
          {
            version: 1,
            bindings: {
              "thread-1": {
                accountId: "default",
                channelId: "parent-1",
                threadId: "thread-1",
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:child",
                agentId: "main",
                boundBy: "system",
                boundAt: now,
                expiresAt: now + 60_000,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const removed = unbindThreadBindingsBySessionKey({
        targetSessionKey: "agent:main:subagent:child",
      });
      expect(removed).toHaveLength(1);

      const payload = JSON.parse(fs.readFileSync(bindingsPath, "utf-8")) as {
        bindings?: Record<string, unknown>;
      };
      expect(Object.keys(payload.bindings ?? {})).toEqual([]);
    } finally {
      __testing.resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
