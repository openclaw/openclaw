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

import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";

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

describe("stopKnownBrowserProfiles — shutdown config isolation", () => {
  beforeEach(() => {
    createBrowserRouteContextMock.mockClear();
    listKnownProfileNamesMock.mockClear();
  });

  it("creates route context with refreshConfigFromDisk: false to prevent orphaned browser processes on shutdown", async () => {
    // Bug: when refreshConfigFromDisk: true, hot-reload during shutdown mutates
    // current.resolved.profiles. Profiles deleted from disk config between
    // listKnownProfileNames() and forProfile() throw "Profile not found",
    // their stopRunningBrowser() is never called, and Chromium children are orphaned.
    //
    // Fix: pass refreshConfigFromDisk: false so shutdown operates on the
    // in-memory snapshot and cannot lose running profiles to a concurrent
    // config change on disk.
    listKnownProfileNamesMock.mockReturnValue(["chrome"]);
    const stopRunningBrowser = vi.fn(async () => ({ stopped: true }));
    createBrowserRouteContextMock.mockReturnValue({
      forProfile: () => ({ stopRunningBrowser }),
    });
    const state = { resolved: { profiles: { chrome: {} } }, profiles: new Map() };

    await stopKnownBrowserProfiles({
      getState: () => state as never,
      onWarn: vi.fn(),
    });

    // Must use refreshConfigFromDisk: false so hot-reload cannot evict
    // in-flight running profiles and orphan their Chromium processes.
    expect(createBrowserRouteContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshConfigFromDisk: false }),
    );
    // stopRunningBrowser must be called — the browser process gets cleaned up.
    expect(stopRunningBrowser).toHaveBeenCalledTimes(1);
  });
});
