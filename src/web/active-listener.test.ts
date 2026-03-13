import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({
  channels: {
    whatsapp: {
      accounts: {
        cc: {},
      },
    },
  },
}));

const resolveDefaultWhatsAppAccountIdMock = vi.fn(() => "cc");

vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

vi.mock("./accounts.js", () => ({
  resolveDefaultWhatsAppAccountId: (...args: unknown[]) =>
    resolveDefaultWhatsAppAccountIdMock(...args),
}));

import {
  getActiveWebListener,
  requireActiveWebListener,
  setActiveWebListener,
} from "./active-listener.js";

function makeListener() {
  return {
    sendComposingTo: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
  };
}

function clearKnownListeners() {
  setActiveWebListener("cc", null);
  setActiveWebListener("work", null);
  setActiveWebListener("default", null);
}

describe("active web listener account resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => ({
      channels: {
        whatsapp: {
          accounts: {
            cc: {},
          },
        },
      },
    }));
    resolveDefaultWhatsAppAccountIdMock.mockImplementation(() => "cc");
    clearKnownListeners();
  });

  afterEach(() => {
    clearKnownListeners();
  });

  it("uses configured default account when accountId is missing", () => {
    const listener = makeListener();
    setActiveWebListener("cc", listener);

    const resolved = requireActiveWebListener();
    expect(resolved.accountId).toBe("cc");
    expect(resolved.listener).toBe(listener);
    expect(getActiveWebListener()).toBe(listener);
  });

  it("remaps explicit default account id to configured default account", () => {
    const listener = makeListener();
    setActiveWebListener("cc", listener);

    const resolved = requireActiveWebListener("default");
    expect(resolved.accountId).toBe("cc");
    expect(resolved.listener).toBe(listener);
  });

  it("keeps explicit non-default account id unchanged", () => {
    const listener = makeListener();
    setActiveWebListener("work", listener);

    const resolved = requireActiveWebListener("work");
    expect(resolved.accountId).toBe("work");
    expect(resolved.listener).toBe(listener);
  });

  it("falls back to legacy default account when config loading fails", () => {
    loadConfigMock.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    const listener = makeListener();
    setActiveWebListener("default", listener);

    const resolved = requireActiveWebListener();
    expect(resolved.accountId).toBe("default");
    expect(resolved.listener).toBe(listener);
  });
});
