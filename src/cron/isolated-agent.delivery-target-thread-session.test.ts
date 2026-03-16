import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Mock session store so we can control what entries exist.
const mockStore: Record<string, Record<string, unknown>> = {};
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn((storePath: string) => mockStore[storePath] ?? {}),
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveStorePath: vi.fn((_store: unknown, _opts: unknown) => "/mock/store.json"),
}));

// Mock channel-selection to avoid real config resolution.
vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: vi.fn(async () => ({ channel: "telegram" })),
}));

// Minimal mock for channel plugins (Telegram resolveTarget is an identity).
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(() => ({
    meta: { label: "Telegram" },
    config: {},
    outbound: {
      resolveTarget: ({ to }: { to?: string }) =>
        to ? { ok: true, to } : { ok: false, error: new Error("missing") },
    },
  })),
  normalizeChannelId: vi.fn((id: string) => id),
}));

const { resolveDeliveryTarget } = await import("./isolated-agent/delivery-target.js");

describe("resolveDeliveryTarget thread session lookup", () => {
  const cfg: OpenClawConfig = {};

  it("uses thread session entry when sessionKey is provided and entry exists", async () => {
    mockStore["/mock/store.json"] = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100111",
      },
      "agent:main:main:thread:9999": {
        sessionId: "s2",
        updatedAt: 2,
        lastChannel: "telegram",
        lastTo: "-100111",
        lastThreadId: 9999,
      },
    };

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "last",
      sessionKey: "agent:main:main:thread:9999",
    });

    expect(result.to).toBe("-100111");
    expect(result.threadId).toBe(9999);
    expect(result.channel).toBe("telegram");
  });

  it("falls back to main session when sessionKey entry does not exist", async () => {
    mockStore["/mock/store.json"] = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100222",
      },
    };

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "last",
      sessionKey: "agent:main:main:thread:nonexistent",
    });

    expect(result.to).toBe("-100222");
    expect(result.threadId).toBeUndefined();
    expect(result.channel).toBe("telegram");
  });

  it("falls back to main session when no sessionKey is provided", async () => {
    mockStore["/mock/store.json"] = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100333",
      },
    };

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "last",
    });

    expect(result.to).toBe("-100333");
    expect(result.threadId).toBeUndefined();
  });

  it("preserves threadId from :topic: in delivery.to on first run (no session history)", async () => {
    mockStore["/mock/store.json"] = {};

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "telegram",
      to: "63448508:topic:1008013",
    });

    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe(1008013);
    expect(result.channel).toBe("telegram");
  });

  it("explicit accountId overrides session lastAccountId", async () => {
    mockStore["/mock/store.json"] = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100444",
        lastAccountId: "session-account",
      },
    };

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "telegram",
      to: "-100444",
      accountId: "explicit-account",
    });

    expect(result.accountId).toBe("explicit-account");
    expect(result.to).toBe("-100444");
  });

  it("preserves threadId from :topic: when lastTo differs", async () => {
    mockStore["/mock/store.json"] = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100999",
      },
    };

    const result = await resolveDeliveryTarget(cfg, "main", {
      channel: "telegram",
      to: "63448508:topic:1008013",
    });

    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe(1008013);
  });
});
