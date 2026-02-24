import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn().mockReturnValue({}),
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "telegram", configured: ["telegram"] }),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStoreSync: vi.fn(() => []),
}));

vi.mock("../../web/accounts.js", () => ({
  resolveWhatsAppAccount: vi.fn(() => ({ allowFrom: [] })),
}));

import { loadSessionStore } from "../../config/sessions.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { readChannelAllowFromStoreSync } from "../../pairing/pairing-store.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

const AGENT_ID = "agent-b";
const DEFAULT_TARGET = {
  channel: "telegram" as const,
  to: "123456",
};

type SessionStore = ReturnType<typeof loadSessionStore>;

function setMainSessionEntry(entry?: SessionStore[string]) {
  const store = entry ? ({ "agent:test:main": entry } as SessionStore) : ({} as SessionStore);
  vi.mocked(loadSessionStore).mockReturnValue(store);
}

function setWhatsAppAllowFrom(allowFrom: string[]) {
  vi.mocked(resolveWhatsAppAccount).mockReturnValue({
    allowFrom,
  } as unknown as ReturnType<typeof resolveWhatsAppAccount>);
}

function setStoredWhatsAppAllowFrom(allowFrom: string[]) {
  vi.mocked(readChannelAllowFromStoreSync).mockReturnValue(allowFrom);
}

async function resolveForAgent(params: {
  cfg: OpenClawConfig;
  target?: { channel?: "last" | "telegram"; to?: string };
}) {
  const channel = params.target ? params.target.channel : DEFAULT_TARGET.channel;
  const to = params.target && "to" in params.target ? params.target.to : DEFAULT_TARGET.to;
  return resolveDeliveryTarget(params.cfg, AGENT_ID, {
    channel,
    to,
  });
}

describe("resolveDeliveryTarget", () => {
  it("reroutes implicit whatsapp delivery to authorized allowFrom recipient", async () => {
    setMainSessionEntry({
      sessionId: "sess-w1",
      updatedAt: 1000,
      lastChannel: "whatsapp",
      lastTo: "+15550000099",
    });
    setWhatsAppAllowFrom([]);
    setStoredWhatsAppAllowFrom(["+15550000001"]);

    const cfg = makeCfg({ bindings: [] });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, { channel: "last", to: undefined });

    expect(result.channel).toBe("whatsapp");
    expect(result.to).toBe("+15550000001");
  });

  it("keeps explicit whatsapp target unchanged", async () => {
    setMainSessionEntry({
      sessionId: "sess-w2",
      updatedAt: 1000,
      lastChannel: "whatsapp",
      lastTo: "+15550000099",
    });
    setWhatsAppAllowFrom([]);
    setStoredWhatsAppAllowFrom(["+15550000001"]);

    const cfg = makeCfg({ bindings: [] });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "whatsapp",
      to: "+15550000099",
    });

    expect(result.to).toBe("+15550000099");
  });

  it("falls back to bound accountId when session has no lastAccountId", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("preserves session lastAccountId when present", async () => {
    setMainSessionEntry({
      sessionId: "sess-1",
      updatedAt: 1000,
      lastChannel: "telegram",
      lastTo: "123456",
      lastAccountId: "session-account",
    });

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    // Session-derived accountId should take precedence over binding
    expect(result.accountId).toBe("session-account");
  });

  it("returns undefined accountId when no binding and no session", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({ bindings: [] });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("selects correct binding when multiple agents have bindings", async () => {
    setMainSessionEntry(undefined);

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

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("ignores bindings for different channels", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "discord", accountId: "discord-account" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("drops session threadId when destination does not match the previous recipient", async () => {
    setMainSessionEntry({
      sessionId: "sess-2",
      updatedAt: 1000,
      lastChannel: "telegram",
      lastTo: "999999",
      lastThreadId: "thread-1",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBeUndefined();
  });

  it("keeps session threadId when destination matches the previous recipient", async () => {
    setMainSessionEntry({
      sessionId: "sess-3",
      updatedAt: 1000,
      lastChannel: "telegram",
      lastTo: "123456",
      lastThreadId: "thread-2",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBe("thread-2");
  });

  it("uses single configured channel when neither explicit nor session channel exists", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveForAgent({
      cfg: makeCfg({ bindings: [] }),
      target: { channel: "last", to: undefined },
    });
    expect(result.channel).toBe("telegram");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unresolved delivery target");
    }
    expect(result.error.message).toContain('No delivery target resolved for channel "telegram"');
  });

  it("returns an error when channel selection is ambiguous", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(resolveMessageChannelSelection).mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const result = await resolveForAgent({
      cfg: makeCfg({ bindings: [] }),
      target: { channel: "last", to: undefined },
    });
    expect(result.channel).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous channel selection error");
    }
    expect(result.error.message).toContain("Channel is required");
  });

  it("uses sessionKey thread entry before main session entry", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:test:main": {
        sessionId: "main-session",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "main-chat",
      },
      "agent:test:thread:42": {
        sessionId: "thread-session",
        updatedAt: 2000,
        lastChannel: "telegram",
        lastTo: "thread-chat",
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:42",
      to: undefined,
    });

    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("thread-chat");
  });

  it("uses main session channel when channel=last and session route exists", async () => {
    setMainSessionEntry({
      sessionId: "sess-4",
      updatedAt: 1000,
      lastChannel: "telegram",
      lastTo: "987654",
    });

    const result = await resolveForAgent({
      cfg: makeCfg({ bindings: [] }),
      target: { channel: "last", to: undefined },
    });

    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("987654");
    expect(result.ok).toBe(true);
  });
});
