import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProfileMock, ensureChromeExtensionRelayServerMock } = vi.hoisted(() => ({
  resolveProfileMock: vi.fn(),
  ensureChromeExtensionRelayServerMock: vi.fn(),
}));

const { createBrowserRouteContextMock, listKnownProfileNamesMock } = vi.hoisted(() => ({
  createBrowserRouteContextMock: vi.fn(),
  listKnownProfileNamesMock: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveProfile: resolveProfileMock,
}));

vi.mock("./extension-relay.js", () => ({
  ensureChromeExtensionRelayServer: ensureChromeExtensionRelayServerMock,
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: createBrowserRouteContextMock,
  listKnownProfileNames: listKnownProfileNamesMock,
}));

import {
  closeIdleTrackedTabs,
  ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles,
} from "./server-lifecycle.js";

describe("ensureExtensionRelayForProfiles", () => {
  beforeEach(() => {
    resolveProfileMock.mockClear();
    ensureChromeExtensionRelayServerMock.mockClear();
  });

  it("starts relay only for extension profiles", async () => {
    resolveProfileMock.mockImplementation((_resolved: unknown, name: string) => {
      if (name === "chrome") {
        return { driver: "extension", cdpUrl: "http://127.0.0.1:18888" };
      }
      return { driver: "openclaw", cdpUrl: "http://127.0.0.1:18889" };
    });
    ensureChromeExtensionRelayServerMock.mockResolvedValue(undefined);

    await ensureExtensionRelayForProfiles({
      resolved: {
        profiles: {
          chrome: {},
          openclaw: {},
        },
      } as never,
      onWarn: vi.fn(),
    });

    expect(ensureChromeExtensionRelayServerMock).toHaveBeenCalledTimes(1);
    expect(ensureChromeExtensionRelayServerMock).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18888",
    });
  });

  it("reports relay startup errors", async () => {
    resolveProfileMock.mockReturnValue({ driver: "extension", cdpUrl: "http://127.0.0.1:18888" });
    ensureChromeExtensionRelayServerMock.mockRejectedValue(new Error("boom"));
    const onWarn = vi.fn();

    await ensureExtensionRelayForProfiles({
      resolved: { profiles: { chrome: {} } } as never,
      onWarn,
    });

    expect(onWarn).toHaveBeenCalledWith(
      'Chrome extension relay init failed for profile "chrome": Error: boom',
    );
  });
});

describe("stopKnownBrowserProfiles", () => {
  beforeEach(() => {
    createBrowserRouteContextMock.mockClear();
    listKnownProfileNamesMock.mockClear();
  });

  it("stops all known profiles and ignores per-profile failures", async () => {
    listKnownProfileNamesMock.mockReturnValue(["openclaw", "chrome"]);
    const stopMap: Record<string, ReturnType<typeof vi.fn>> = {
      openclaw: vi.fn(async () => {}),
      chrome: vi.fn(async () => {
        throw new Error("profile stop failed");
      }),
    };
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: (name: string) => ({
        stopRunningBrowser: stopMap[name],
      }),
    });
    const onWarn = vi.fn();
    const state = { resolved: { profiles: {} }, profiles: new Map() };

    await stopKnownBrowserProfiles({
      getState: () => state as never,
      onWarn,
    });

    expect(stopMap.openclaw).toHaveBeenCalledTimes(1);
    expect(stopMap.chrome).toHaveBeenCalledTimes(1);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("warns when profile enumeration fails", async () => {
    listKnownProfileNamesMock.mockImplementation(() => {
      throw new Error("oops");
    });
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: vi.fn(),
    });
    const onWarn = vi.fn();

    await stopKnownBrowserProfiles({
      getState: () => ({ resolved: { profiles: {} }, profiles: new Map() }) as never,
      onWarn,
    });

    expect(onWarn).toHaveBeenCalledWith("openclaw browser stop failed: Error: oops");
  });
});

describe("closeIdleTrackedTabs", () => {
  beforeEach(() => {
    createBrowserRouteContextMock.mockClear();
  });

  function makeProfileState(tabEntries: [string, { lastAccessedAt: number }][]) {
    return {
      openedTabs: new Map(
        tabEntries.map(([id, info]) => [id, { openedAt: info.lastAccessedAt, ...info }]),
      ),
    };
  }

  it("does nothing when tabIdleTimeoutMs is 0", async () => {
    const closeTab = vi.fn();
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: () => ({ closeTab }),
    });
    const state = {
      resolved: { tabIdleTimeoutMs: 0 },
      profiles: new Map([["openclaw", makeProfileState([["tab-1", { lastAccessedAt: 0 }]])]]),
    };

    await closeIdleTrackedTabs({ getState: () => state as never, onWarn: vi.fn() });

    expect(closeTab).not.toHaveBeenCalled();
  });

  it("does nothing when no state is available", async () => {
    const closeTab = vi.fn();
    createBrowserRouteContextMock.mockReturnValue({ forProfile: () => ({ closeTab }) });

    await closeIdleTrackedTabs({ getState: () => null, onWarn: vi.fn() });

    expect(closeTab).not.toHaveBeenCalled();
  });

  it("closes tabs whose lastAccessedAt exceeds the idle timeout", async () => {
    const closeTab = vi.fn(async () => {});
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: () => ({ closeTab }),
    });
    const now = Date.now();
    const state = {
      resolved: { tabIdleTimeoutMs: 60_000 },
      profiles: new Map([
        [
          "openclaw",
          makeProfileState([
            ["tab-idle", { lastAccessedAt: now - 90_000 }], // 90 s ago → idle
            ["tab-active", { lastAccessedAt: now - 10_000 }], // 10 s ago → active
          ]),
        ],
      ]),
    };

    await closeIdleTrackedTabs({ getState: () => state as never, onWarn: vi.fn() });

    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith("tab-idle");
  });

  it("removes stale tracking entry when closeTab fails", async () => {
    const closeTab = vi.fn(async () => {
      throw new Error("tab not found");
    });
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: () => ({ closeTab }),
    });
    const now = Date.now();
    const openedTabs = new Map([
      ["tab-gone", { openedAt: now - 200_000, lastAccessedAt: now - 200_000 }],
    ]);
    const state = {
      resolved: { tabIdleTimeoutMs: 60_000 },
      profiles: new Map([["openclaw", { openedTabs }]]),
    };

    await closeIdleTrackedTabs({ getState: () => state as never, onWarn: vi.fn() });

    // Stale entry should be purged even though closeTab threw
    expect(openedTabs.size).toBe(0);
  });

  it("skips profiles with no openedTabs", async () => {
    const closeTab = vi.fn();
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: () => ({ closeTab }),
    });
    const state = {
      resolved: { tabIdleTimeoutMs: 60_000 },
      profiles: new Map([["openclaw", { openedTabs: undefined }]]),
    };

    await closeIdleTrackedTabs({ getState: () => state as never, onWarn: vi.fn() });

    expect(closeTab).not.toHaveBeenCalled();
  });
});
