import { describe, expect, it } from "vitest";
import { createBrowserRouteContext } from "./server-context.js";
import type { BrowserServerState } from "./server-context.js";

function makeState(defaultProfile: string): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      color: "#FF4500",
      headless: true,
      noSandbox: true,
      attachOnly: false,
      defaultProfile,
      profiles: {
        openclaw: {
          cdpPort: 18800,
          color: "#FF4500",
        },
        user: {
          driver: "existing-session",
          attachOnly: true,
          color: "#00AA00",
        },
        "chrome-relay": {
          driver: "extension",
          cdpUrl: "http://127.0.0.1:18792",
          color: "#00AA00",
        },
      },
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    profiles: new Map(),
  };
}

describe("browser server-context headless implicit default profile", () => {
  it("falls back from extension relay to openclaw when no profile is specified", () => {
    const ctx = createBrowserRouteContext({
      getState: () => makeState("chrome-relay"),
    });

    expect(ctx.forProfile().profile.name).toBe("openclaw");
  });

  it("keeps existing-session as the implicit default in headless mode", () => {
    const ctx = createBrowserRouteContext({
      getState: () => makeState("user"),
    });

    expect(ctx.forProfile().profile.name).toBe("user");
  });

  it("keeps explicit interactive profile requests unchanged in headless mode", () => {
    const ctx = createBrowserRouteContext({
      getState: () => makeState("chrome-relay"),
    });

    expect(ctx.forProfile("chrome-relay").profile.name).toBe("chrome-relay");
    expect(ctx.forProfile("user").profile.name).toBe("user");
  });
});
