import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStoreSync: vi.fn(() => []),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { readChannelAllowFromStoreSync } from "../../pairing/pairing-store.js";
import { resolveWhatsAppHeartbeatRecipients } from "./whatsapp-heartbeat.js";

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveWhatsAppHeartbeatRecipients", () => {
  beforeEach(() => {
    vi.mocked(loadSessionStore).mockReset();
    vi.mocked(readChannelAllowFromStoreSync).mockReset();
    vi.mocked(readChannelAllowFromStoreSync).mockReturnValue([]);
  });

  it("uses allowFrom store recipients when session recipients are ambiguous", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
    });
    vi.mocked(readChannelAllowFromStoreSync).mockReturnValue(["+15550000001"]);

    const cfg = makeCfg();
    const result = resolveWhatsAppHeartbeatRecipients(cfg);

    expect(result).toEqual({ recipients: ["+15550000001"], source: "session-single" });
  });

  it("falls back to allowFrom when no session recipient is authorized", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    vi.mocked(readChannelAllowFromStoreSync).mockReturnValue(["+15550000001"]);

    const cfg = makeCfg();
    const result = resolveWhatsAppHeartbeatRecipients(cfg);

    expect(result).toEqual({ recipients: ["+15550000001"], source: "allowFrom" });
  });

  it("includes both session and allowFrom recipients when --all is set", () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    vi.mocked(readChannelAllowFromStoreSync).mockReturnValue(["+15550000001"]);

    const cfg = makeCfg();
    const result = resolveWhatsAppHeartbeatRecipients(cfg, { all: true });

    expect(result).toEqual({
      recipients: ["+15550000099", "+15550000001"],
      source: "all",
    });
  });
});
