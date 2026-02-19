import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn().mockReturnValue({}),
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: vi.fn().mockResolvedValue({ channel: "telegram" }),
}));

import { loadSessionStore } from "../../config/sessions.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveDeliveryTarget", () => {
  it("falls back to bound accountId when session has no lastAccountId", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBe("account-b");
  });

  it("preserves session lastAccountId when present", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:test:main": {
        sessionId: "sess-1",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "123456",
        lastAccountId: "session-account",
      },
    });

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    // Session-derived accountId should take precedence over binding
    expect(result.accountId).toBe("session-account");
  });

  it("returns undefined accountId when no binding and no session", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({ bindings: [] });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBeUndefined();
  });

  it("selects correct binding when multiple agents have bindings", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-a",
          match: { channel: "telegram", accountId: "account-a" },
        },
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBe("account-b");
  });

  it("ignores bindings for different channels", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "discord", accountId: "discord-account" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBeUndefined();
  });
});
