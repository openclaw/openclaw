import { afterEach, describe, expect, it, vi } from "vitest";

// Mock chrome.js (standard test harness for server-context tests)
vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

// Mock firecrawl-browser.js
vi.mock("./firecrawl-browser.js", () => ({
  createFirecrawlBrowserSession: vi.fn(async () => {
    throw new Error("unexpected firecrawl create");
  }),
  deleteFirecrawlBrowserSession: vi.fn(async () => {}),
  isFirecrawlSessionReachable: vi.fn(async () => false),
}));

import * as firecrawlModule from "./firecrawl-browser.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext } from "./server-context.js";

function makeFirecrawlState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18810,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: "firecrawl",
      profiles: {
        firecrawl: { driver: "firecrawl", color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("firecrawl browser availability", () => {
  const createMock = vi.mocked(firecrawlModule.createFirecrawlBrowserSession);
  const deleteMock = vi.mocked(firecrawlModule.deleteFirecrawlBrowserSession);
  const reachableMock = vi.mocked(firecrawlModule.isFirecrawlSessionReachable);

  const firecrawlSession = {
    sessionId: "sess-test-1",
    cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-test-1",
    liveViewUrl: "https://connect.firecrawl.dev/v/sess-test-1",
    expiresAt: "2026-03-02T12:00:00Z",
  };

  describe("ensureBrowserAvailable", () => {
    it("creates a new firecrawl session when none exists", async () => {
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        firecrawlBaseUrl: "https://api.firecrawl.dev",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(createMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://api.firecrawl.dev",
      });

      const profileState = state.profiles.get("firecrawl");
      expect(profileState?.firecrawlSession).toEqual(firecrawlSession);
      expect(profileState?.profile.cdpUrl).toBe("wss://connect.firecrawl.dev/sess-test-1");
    });

    it("reuses existing session when reachable", async () => {
      reachableMock.mockResolvedValue(true);

      const state = makeFirecrawlState();
      // Pre-seed the profile state with an existing session
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-existing",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-existing",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-existing",
          liveViewUrl: "https://connect.firecrawl.dev/v/sess-existing",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(createMock).not.toHaveBeenCalled();
      expect(reachableMock).toHaveBeenCalledWith("wss://connect.firecrawl.dev/sess-existing");
    });

    it("replaces stale session when not reachable", async () => {
      reachableMock.mockResolvedValue(false);
      createMock.mockResolvedValue({
        sessionId: "sess-new",
        cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-new",
        liveViewUrl: "https://connect.firecrawl.dev/v/sess-new",
      });

      const state = makeFirecrawlState();
      // Pre-seed with a stale session
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-stale",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-stale",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-stale",
          liveViewUrl: "https://connect.firecrawl.dev/v/sess-stale",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(reachableMock).toHaveBeenCalled();
      expect(createMock).toHaveBeenCalled();

      const profileState = state.profiles.get("firecrawl");
      expect(profileState?.firecrawlSession?.sessionId).toBe("sess-new");
      expect(profileState?.profile.cdpUrl).toBe("wss://connect.firecrawl.dev/sess-new");
    });

    it("clears stale session before creating new one", async () => {
      reachableMock.mockResolvedValue(false);
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-old",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-old",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      // Verify create was called after the stale session was cleared
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("throws when no API key is configured", async () => {
      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        // no firecrawlApiKey
      });
      const profile = ctx.forProfile("firecrawl");

      await expect(profile.ensureBrowserAvailable()).rejects.toThrow(
        /Firecrawl browser profile requires an API key/,
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    it("propagates create session errors", async () => {
      createMock.mockRejectedValue(
        new Error("Firecrawl browser session create failed (HTTP 500): boom"),
      );

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await expect(profile.ensureBrowserAvailable()).rejects.toThrow(
        "Firecrawl browser session create failed (HTTP 500): boom",
      );
    });

    it("uses default baseUrl when firecrawlBaseUrl is not provided", async () => {
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        // no firecrawlBaseUrl — should default to https://api.firecrawl.dev
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(createMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://api.firecrawl.dev",
      });
    });

    it("uses custom baseUrl when firecrawlBaseUrl is provided", async () => {
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        firecrawlBaseUrl: "https://custom-firecrawl.example.com",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(createMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://custom-firecrawl.example.com",
      });
    });

    it("does not call launchOpenClawChrome for firecrawl profiles", async () => {
      const { launchOpenClawChrome } = await import("./chrome.js");
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();

      expect(launchOpenClawChrome).not.toHaveBeenCalled();
    });
  });

  describe("isReachable / isHttpReachable", () => {
    it("returns false when no firecrawl session exists", async () => {
      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const reachable = await profile.isReachable();
      expect(reachable).toBe(false);
      expect(reachableMock).not.toHaveBeenCalled();
    });

    it("delegates to isFirecrawlSessionReachable when session exists", async () => {
      reachableMock.mockResolvedValue(true);

      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-r",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-r",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-r",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.isReachable(5000);
      expect(result).toBe(true);
      expect(reachableMock).toHaveBeenCalledWith(
        "wss://connect.firecrawl.dev/sess-r",
        5000,
      );
    });

    it("isHttpReachable returns false when no session", async () => {
      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const reachable = await profile.isHttpReachable();
      expect(reachable).toBe(false);
    });

    it("isHttpReachable delegates to isFirecrawlSessionReachable when session exists", async () => {
      reachableMock.mockResolvedValue(false);

      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-h",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-h",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-h",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.isHttpReachable();
      expect(result).toBe(false);
      expect(reachableMock).toHaveBeenCalledWith(
        "wss://connect.firecrawl.dev/sess-h",
        // timeoutMs is passed through from isHttpReachable arg; undefined when called with no args
        undefined,
      );
    });

    it("isHttpReachable passes explicit timeout to reachability check", async () => {
      reachableMock.mockResolvedValue(true);

      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-ht",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-ht",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-ht",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.isHttpReachable(2000);
      expect(result).toBe(true);
      expect(reachableMock).toHaveBeenCalledWith(
        "wss://connect.firecrawl.dev/sess-ht",
        2000,
      );
    });

    it("does not call isChromeReachable or isChromeCdpReady for firecrawl", async () => {
      const { isChromeReachable, isChromeCdpReady } = await import("./chrome.js");

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.isReachable();
      await profile.isHttpReachable();

      expect(isChromeReachable).not.toHaveBeenCalled();
      expect(isChromeCdpReady).not.toHaveBeenCalled();
    });
  });

  describe("stopRunningBrowser", () => {
    it("deletes firecrawl session when one exists", async () => {
      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-stop",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-stop",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-stop",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        firecrawlBaseUrl: "https://api.firecrawl.dev",
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.stopRunningBrowser();

      expect(result.stopped).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://api.firecrawl.dev",
        sessionId: "sess-stop",
      });
      expect(state.profiles.get("firecrawl")?.firecrawlSession).toBeNull();
    });

    it("returns stopped=false when no session exists", async () => {
      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.stopRunningBrowser();

      expect(result.stopped).toBe(false);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("clears session even when delete API call fails (best-effort)", async () => {
      deleteMock.mockRejectedValue(new Error("delete failed"));

      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "wss://connect.firecrawl.dev/sess-fail",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-fail",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-fail",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      // Should not throw — delete errors are caught
      const result = await profile.stopRunningBrowser();
      expect(result.stopped).toBe(true);
      expect(state.profiles.get("firecrawl")?.firecrawlSession).toBeNull();
    });

    it("does not attempt delete when no API key is available", async () => {
      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-nokey",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-nokey",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        // no firecrawlApiKey
      });
      const profile = ctx.forProfile("firecrawl");

      const result = await profile.stopRunningBrowser();
      expect(result.stopped).toBe(true);
      expect(deleteMock).not.toHaveBeenCalled();
      expect(state.profiles.get("firecrawl")?.firecrawlSession).toBeNull();
    });

    it("uses default baseUrl for delete when firecrawlBaseUrl not configured", async () => {
      const state = makeFirecrawlState();
      state.profiles.set("firecrawl", {
        profile: {
          name: "firecrawl",
          cdpPort: 0,
          cdpUrl: "",
          cdpHost: "",
          cdpIsLoopback: false,
          color: "#FF4500",
          driver: "firecrawl",
          attachOnly: true,
        },
        running: null,
        firecrawlSession: {
          sessionId: "sess-default-url",
          cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-default-url",
          liveViewUrl: "",
        },
      });

      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        // no firecrawlBaseUrl
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.stopRunningBrowser();

      expect(deleteMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://api.firecrawl.dev",
        sessionId: "sess-default-url",
      });
    });

    it("does not call stopOpenClawChrome for firecrawl profiles", async () => {
      const { stopOpenClawChrome } = await import("./chrome.js");

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.stopRunningBrowser();

      expect(stopOpenClawChrome).not.toHaveBeenCalled();
    });
  });

  describe("full lifecycle", () => {
    it("create → reuse → stop lifecycle", async () => {
      // Step 1: Create session
      createMock.mockResolvedValue(firecrawlSession);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
        firecrawlBaseUrl: "https://api.firecrawl.dev",
      });
      const profile = ctx.forProfile("firecrawl");

      await profile.ensureBrowserAvailable();
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(state.profiles.get("firecrawl")?.firecrawlSession?.sessionId).toBe("sess-test-1");

      // Step 2: Reuse existing session
      reachableMock.mockResolvedValue(true);
      await profile.ensureBrowserAvailable();
      expect(createMock).toHaveBeenCalledTimes(1); // no new create call

      // Step 3: Stop
      const result = await profile.stopRunningBrowser();
      expect(result.stopped).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith({
        apiKey: "fc-test-key",
        baseUrl: "https://api.firecrawl.dev",
        sessionId: "sess-test-1",
      });
      expect(state.profiles.get("firecrawl")?.firecrawlSession).toBeNull();
    });

    it("create → expire → recreate lifecycle", async () => {
      const session1 = {
        ...firecrawlSession,
        sessionId: "sess-1",
        cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-1",
      };
      const session2 = {
        ...firecrawlSession,
        sessionId: "sess-2",
        cdpWebSocketUrl: "wss://connect.firecrawl.dev/sess-2",
      };

      createMock.mockResolvedValueOnce(session1).mockResolvedValueOnce(session2);

      const state = makeFirecrawlState();
      const ctx = createBrowserRouteContext({
        getState: () => state,
        firecrawlApiKey: "fc-test-key",
      });
      const profile = ctx.forProfile("firecrawl");

      // Step 1: Create first session
      await profile.ensureBrowserAvailable();
      expect(state.profiles.get("firecrawl")?.firecrawlSession?.sessionId).toBe("sess-1");
      expect(state.profiles.get("firecrawl")?.profile.cdpUrl).toBe(
        "wss://connect.firecrawl.dev/sess-1",
      );

      // Step 2: Session expires (not reachable)
      reachableMock.mockResolvedValue(false);
      await profile.ensureBrowserAvailable();
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(state.profiles.get("firecrawl")?.firecrawlSession?.sessionId).toBe("sess-2");
      expect(state.profiles.get("firecrawl")?.profile.cdpUrl).toBe(
        "wss://connect.firecrawl.dev/sess-2",
      );
    });
  });
});
