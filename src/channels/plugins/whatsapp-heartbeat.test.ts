import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadSessionStoreMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreSyncMock = vi.hoisted(() => vi.fn<() => string[]>(() => []));

type WhatsAppHeartbeatModule = typeof import("./whatsapp-heartbeat.js");

let resolveWhatsAppHeartbeatRecipients: WhatsAppHeartbeatModule["resolveWhatsAppHeartbeatRecipients"];

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveWhatsAppHeartbeatRecipients", () => {
  function setSessionStore(store: Record<string, unknown>) {
    loadSessionStoreMock.mockReturnValue(store);
  }

  function setAllowFromStore(entries: string[]) {
    readChannelAllowFromStoreSyncMock.mockReturnValue(entries);
  }

  function resolveWith(
    cfgOverrides: Partial<OpenClawConfig> = {},
    opts?: Parameters<typeof resolveWhatsAppHeartbeatRecipients>[1],
  ) {
    return resolveWhatsAppHeartbeatRecipients(makeCfg(cfgOverrides), opts);
  }

  function setSingleUnauthorizedSessionWithAllowFrom() {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    setAllowFromStore(["+15550000001"]);
  }

  beforeEach(async () => {
    vi.resetModules();
    loadSessionStoreMock.mockReset();
    readChannelAllowFromStoreSyncMock.mockReset();
    vi.doMock("../../config/sessions/store-summary.js", () => ({
      loadSessionStoreSummary: loadSessionStoreMock,
    }));
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
    }));
    vi.doMock("../../pairing/pairing-store.js", () => ({
      readChannelAllowFromStoreSync: readChannelAllowFromStoreSyncMock,
    }));
    ({ resolveWhatsAppHeartbeatRecipients } = await import("./whatsapp-heartbeat.js"));
    setAllowFromStore([]);
  });

  it("uses allowFrom store recipients when session recipients are ambiguous", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
    });
    setAllowFromStore(["+15550000001"]);

    const result = resolveWith();

    expect(result).toEqual({ recipients: ["+15550000001"], source: "session-single" });
  });

  it("treats BR ninth-digit variants as authorized session recipients", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+5535998627740", updatedAt: 2, sessionId: "a" },
    });
    setAllowFromStore(["+553598627740"]);

    const result = resolveWith();

    expect(result).toEqual({ recipients: ["+5535998627740"], source: "session-single" });
  });

  it("falls back to allowFrom when no session recipient is authorized", () => {
    setSingleUnauthorizedSessionWithAllowFrom();

    const result = resolveWith();

    expect(result).toEqual({ recipients: ["+15550000001"], source: "allowFrom" });
  });

  it("includes both session and allowFrom recipients when --all is set", () => {
    setSingleUnauthorizedSessionWithAllowFrom();

    const result = resolveWith({}, { all: true });

    expect(result).toEqual({
      recipients: ["+15550000099", "+15550000001"],
      source: "all",
    });
  });

  it("returns explicit --to recipient and source flag", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith({}, { to: " +1 555 000 7777 " });
    expect(result).toEqual({ recipients: ["+15550007777"], source: "flag" });
  });

  it("returns ambiguous session recipients when no allowFrom list exists", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
    });
    const result = resolveWith();
    expect(result).toEqual({
      recipients: ["+15550000001", "+15550000002"],
      source: "session-ambiguous",
    });
  });

  it("returns single session recipient when allowFrom is empty", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith();
    expect(result).toEqual({ recipients: ["+15550000001"], source: "session-single" });
  });

  it("returns all authorized session recipients when allowFrom matches multiple", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
      c: { lastChannel: "whatsapp", lastTo: "+15550000003", updatedAt: 0, sessionId: "c" },
    });
    setAllowFromStore(["+15550000001", "+15550000002"]);
    const result = resolveWith();
    expect(result).toEqual({
      recipients: ["+15550000001", "+15550000002"],
      source: "session-ambiguous",
    });
  });

  it("ignores session store when session scope is global", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith({
      session: { scope: "global" } as OpenClawConfig["session"],
      channels: { whatsapp: { allowFrom: ["*", "+15550000009"] } as never },
    });
    expect(result).toEqual({ recipients: ["+15550000009"], source: "allowFrom" });
  });
});
