import { beforeEach, describe, expect, it, vi } from "vitest";

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true } },
  })),
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    defaultProfile: "chrome",
  })),
}));

vi.mock("../browser/control-service.js", () => controlServiceMocks);
vi.mock("../browser/routes/dispatcher.js", () => dispatcherMocks);
vi.mock("../config/config.js", () => configMocks);
vi.mock("../browser/config.js", () => browserConfigMocks);
vi.mock("../media/mime.js", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

import { runBrowserProxyCommand } from "./invoke-browser.js";

describe("runBrowserProxyCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      enabled: true,
      defaultProfile: "chrome",
    });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
  });

  it("adds profile and browser status details on ws-backed timeouts", async () => {
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: "http://127.0.0.1:18792",
        },
      });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "chrome",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=chrome; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=http:\/\/127\.0\.0\.1:18792\)/,
    );
  });

  it("keeps non-timeout browser errors intact", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 500,
      body: { error: "tab not found" },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/act",
          profile: "chrome",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("tab not found");
  });
});
