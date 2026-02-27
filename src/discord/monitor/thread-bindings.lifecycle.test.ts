import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

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
  const readAcpSessionEntry = vi.fn();
  return {
    sendMessageDiscord,
    sendWebhookMessageDiscord,
    restGet,
    restPost,
    createDiscordRestClient,
    createThreadDiscord,
    readAcpSessionEntry,
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

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: hoisted.readAcpSessionEntry,
}));

const {
  __testing,
  autoBindSpawnedDiscordSubagent,
  createThreadBindingManager,
  reconcileAcpThreadBindingsOnStartup,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingIntroText,
  resolveThreadBindingMaxAgeExpiresAt,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
} = await import("./thread-bindings.js");

describe("thread binding lifecycle", () => {
  beforeEach(() => {
    __testing.resetThreadBindingsForTests();
    hoisted.sendMessageDiscord.mockClear();
    hoisted.sendWebhookMessageDiscord.mockClear();
    hoisted.restGet.mockClear();
    hoisted.restPost.mockClear();
    hoisted.createDiscordRestClient.mockClear();
    hoisted.createThreadDiscord.mockClear();
    hoisted.readAcpSessionEntry.mockReset().mockReturnValue(null);
    vi.useRealTimers();
  });

  const createDefaultSweeperManager = () =>
    createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: true,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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

  it("includes idle and max-age details in intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "main",
      label: "worker",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 48 * 60 * 60 * 1000,
    });
    expect(intro).toContain("idle auto-unfocus after 24h inactivity");
    expect(intro).toContain("max age 48h");
  });

  it("includes cwd near the top of intro text", () => {
    const intro = resolveThreadBindingIntroText({
      agentId: "codex",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      sessionCwd: "/home/bob/clawd",
      sessionDetails: ["session ids: pending (available after the first reply)"],
    });
    expect(intro).toContain("\ncwd: /home/bob/clawd\nsession ids: pending");
  });

  it("auto-unfocuses idle-expired bindings and sends inactivity message", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
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
      expect(farewell).toContain("after 1m of inactivity");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-unfocuses max-age-expired bindings and sends max-age message", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 0,
        maxAgeMs: 60_000,
      });

      const binding = await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      expect(binding).not.toBeNull();
      hoisted.sendMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      expect(hoisted.sendMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = hoisted.sendMessageDiscord.mock.calls[0]?.[1] as string | undefined;
      expect(farewell).toContain("max age of 1m");
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

  it("updates idle timeout by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T23:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
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

      const boundAt = manager.getByThreadId("thread-1")?.boundAt;
      vi.setSystemTime(new Date("2026-02-20T23:15:00.000Z"));

      const updated = setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });

      expect(updated).toHaveLength(1);
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T23:15:00.000Z").getTime());
      expect(updated[0]?.boundAt).toBe(boundAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: updated[0],
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-21T01:15:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates max age by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
      });

      vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
      const updated = setThreadBindingMaxAgeBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        maxAgeMs: 3 * 60 * 60 * 1000,
      });

      expect(updated).toHaveLength(1);
      expect(updated[0]?.boundAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          record: updated[0],
          defaultMaxAgeMs: manager.getMaxAgeMs(),
        }),
      ).toBe(new Date("2026-02-20T13:30:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when idle timeout is disabled per session key", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
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

      const updated = setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 0,
      });
      expect(updated).toHaveLength(1);
      expect(updated[0]?.idleTimeoutMs).toBe(0);

      await vi.advanceTimersByTimeAsync(240_000);

      expect(manager.getByThreadId("thread-1")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a binding when activity is touched during the same sweep pass", async () => {
    vi.useFakeTimers();
    try {
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:first",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      await manager.bindTarget({
        threadId: "thread-2",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:second",
        agentId: "main",
        webhookId: "wh-2",
        webhookToken: "tok-2",
      });

      // Keep the first binding off the idle-expire path so the sweep performs
      // an awaited probe and gives a window for in-pass touches.
      setThreadBindingIdleTimeoutBySessionKey({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:first",
        idleTimeoutMs: 0,
      });

      hoisted.restGet.mockImplementation(async (...args: unknown[]) => {
        const route = typeof args[0] === "string" ? args[0] : "";
        if (route.includes("thread-1")) {
          manager.touchThread({ threadId: "thread-2", persist: false });
        }
        return {
          id: route.split("/").at(-1) ?? "thread-1",
          type: 11,
          parent_id: "parent-1",
        };
      });
      hoisted.sendMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-2")).toBeDefined();
      expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes inactivity window when thread activity is touched", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
      });

      vi.setSystemTime(new Date("2026-02-20T00:00:30.000Z"));
      const touched = manager.touchThread({ threadId: "thread-1", persist: false });
      expect(touched).not.toBeNull();

      const record = manager.getByThreadId("thread-1");
      expect(record).toBeDefined();
      expect(record?.lastActivityAt).toBe(new Date("2026-02-20T00:00:30.000Z").getTime());
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: record!,
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-20T00:01:30.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists touched activity timestamps across restart when persistence is enabled", async () => {
    vi.useFakeTimers();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: true,
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
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

      const touchedAt = new Date("2026-02-20T00:00:30.000Z").getTime();
      vi.setSystemTime(touchedAt);
      manager.touchThread({ threadId: "thread-1" });

      __testing.resetThreadBindingsForTests();
      const reloaded = createThreadBindingManager({
        accountId: "default",
        persist: true,
        enableSweeper: false,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
      });

      const record = reloaded.getByThreadId("thread-1");
      expect(record).toBeDefined();
      expect(record?.lastActivityAt).toBe(touchedAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: record!,
          defaultIdleTimeoutMs: reloaded.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-20T00:01:30.000Z").getTime());
    } finally {
      __testing.resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("reuses webhook credentials after unbind when rebinding in the same channel", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    });
    const manager = createThreadBindingManager({
      accountId: "runtime",
      token: "token-new",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    });
    const b = createThreadBindingManager({
      accountId: "b",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
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

  it("removes stale ACP bindings during startup reconciliation", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    });

    await manager.bindTarget({
      threadId: "thread-acp-healthy",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:healthy",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      threadId: "thread-acp-stale",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:stale",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      threadId: "thread-subagent",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === "agent:codex:acp:healthy") {
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:healthy",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        };
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: undefined,
      };
    });

    const result = reconcileAcpThreadBindingsOnStartup({
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });

    expect(result.checked).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.staleSessionKeys).toContain("agent:codex:acp:stale");
    expect(manager.getByThreadId("thread-acp-healthy")).toBeDefined();
    expect(manager.getByThreadId("thread-acp-stale")).toBeUndefined();
    expect(manager.getByThreadId("thread-subagent")).toBeDefined();
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
  });

  it("keeps ACP bindings when session store reads fail during startup reconciliation", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    });

    await manager.bindTarget({
      threadId: "thread-acp-uncertain",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:uncertain",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex:acp:uncertain",
      storeSessionKey: "agent:codex:acp:uncertain",
      cfg: {} as OpenClawConfig,
      storePath: "/tmp/mock-sessions.json",
      storeReadFailed: true,
      entry: undefined,
      acp: undefined,
    });

    const result = reconcileAcpThreadBindingsOnStartup({
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toEqual([]);
    expect(manager.getByThreadId("thread-acp-uncertain")).toBeDefined();
  });

  it("migrates legacy expiresAt bindings to idle/max-age semantics", () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      __testing.resetThreadBindingsForTests();
      const bindingsPath = __testing.resolveThreadBindingsPath();
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
      const boundAt = Date.now() - 10_000;
      const expiresAt = boundAt + 60_000;
      fs.writeFileSync(
        bindingsPath,
        JSON.stringify(
          {
            version: 1,
            bindings: {
              "thread-legacy-active": {
                accountId: "default",
                channelId: "parent-1",
                threadId: "thread-legacy-active",
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:legacy-active",
                agentId: "main",
                boundBy: "system",
                boundAt,
                expiresAt,
              },
              "thread-legacy-disabled": {
                accountId: "default",
                channelId: "parent-1",
                threadId: "thread-legacy-disabled",
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:legacy-disabled",
                agentId: "main",
                boundBy: "system",
                boundAt,
                expiresAt: 0,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
      });

      const active = manager.getByThreadId("thread-legacy-active");
      expect(active).toBeDefined();
      expect(active?.idleTimeoutMs).toBe(0);
      expect(active?.maxAgeMs).toBe(expiresAt - boundAt);
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          record: active!,
          defaultMaxAgeMs: manager.getMaxAgeMs(),
        }),
      ).toBe(expiresAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: active!,
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBeUndefined();

      const disabled = manager.getByThreadId("thread-legacy-disabled");
      expect(disabled).toBeDefined();
      expect(disabled?.idleTimeoutMs).toBe(0);
      expect(disabled?.maxAgeMs).toBe(0);
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          record: disabled!,
          defaultMaxAgeMs: manager.getMaxAgeMs(),
        }),
      ).toBeUndefined();
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: disabled!,
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBeUndefined();
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
                lastActivityAt: now,
                idleTimeoutMs: 60_000,
                maxAgeMs: 0,
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
