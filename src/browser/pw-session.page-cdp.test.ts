import { beforeEach, describe, expect, it, vi } from "vitest";

const cdpHelperMocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  withCdpSocket: vi.fn(),
}));

const chromeMocks = vi.hoisted(() => ({
  getChromeWebSocketUrl: vi.fn(async () => "ws://127.0.0.1:18792/cdp"),
}));

vi.mock("./cdp.helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./cdp.helpers.js")>("./cdp.helpers.js");
  return {
    ...actual,
    fetchJson: cdpHelperMocks.fetchJson,
    withCdpSocket: cdpHelperMocks.withCdpSocket,
  };
});

vi.mock("./chrome.js", () => chromeMocks);

import { isExtensionRelayCdpEndpoint, withPageScopedCdpClient } from "./pw-session.page-cdp.js";

describe("pw-session page-scoped CDP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses raw relay /cdp commands for extension endpoints when targetId is known", async () => {
    cdpHelperMocks.fetchJson.mockResolvedValue({ Browser: "OpenClaw/extension-relay" });
    const send = vi.fn(async () => ({ ok: true }));
    cdpHelperMocks.withCdpSocket.mockImplementation(async (_wsUrl, fn) => await fn(send));
    const newCDPSession = vi.fn();
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:18792",
      page: page as never,
      targetId: "tab-1",
      fn: async (pageSend) => {
        await pageSend("Page.bringToFront", { foo: "bar" });
      },
    });

    expect(send).toHaveBeenCalledWith("Page.bringToFront", {
      foo: "bar",
      targetId: "tab-1",
    });
    expect(newCDPSession).not.toHaveBeenCalled();
  });

  it("falls back to Playwright page sessions for non-relay endpoints", async () => {
    cdpHelperMocks.fetchJson.mockResolvedValue({ Browser: "Chrome/145.0" });
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      fn: async (pageSend) => {
        await pageSend("Emulation.setLocaleOverride", { locale: "en-US" });
      },
    });

    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(sessionSend).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
    expect(cdpHelperMocks.withCdpSocket).not.toHaveBeenCalled();
  });

  it("caches extension-relay endpoint detection by cdpUrl", async () => {
    cdpHelperMocks.fetchJson.mockResolvedValue({ Browser: "OpenClaw/extension-relay" });

    await expect(isExtensionRelayCdpEndpoint("http://127.0.0.1:19992")).resolves.toBe(true);
    await expect(isExtensionRelayCdpEndpoint("http://127.0.0.1:19992/")).resolves.toBe(true);

    expect(cdpHelperMocks.fetchJson).toHaveBeenCalledTimes(1);
  });
});
