import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "../../extensions/browser/src/browser/test-port.js";

const mocks = vi.hoisted(() => ({
  controlPort: 0,
  ensureBrowserControlAuth: vi.fn(async () => {
    throw new Error("read-only config");
  }),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const browserConfig = {
    enabled: true,
  };
  return {
    ...actual,
    loadConfig: () => ({
      browser: browserConfig,
    }),
  };
});

vi.mock("../../extensions/browser/src/browser/config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../extensions/browser/src/browser/config.js")>();
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: mocks.controlPort,
    })),
  };
});

vi.mock("../../extensions/browser/src/browser/control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("../../extensions/browser/src/browser/routes/index.js", () => ({
  registerBrowserRoutes: vi.fn(() => {}),
}));

vi.mock("../../extensions/browser/src/browser/server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("../../extensions/browser/src/browser/server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("../../extensions/browser/src/browser/pw-ai-state.js", () => ({
  isPwAiLoaded: vi.fn(() => false),
}));

let startBrowserControlServerFromConfig: typeof import("../../extensions/browser/src/browser/server.js").startBrowserControlServerFromConfig;
let stopBrowserControlServer: typeof import("../../extensions/browser/src/browser/server.js").stopBrowserControlServer;

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.ensureExtensionRelayForProfiles.mockClear();
    vi.resetModules();
    ({ startBrowserControlServerFromConfig, stopBrowserControlServer } =
      await import("../../extensions/browser/src/browser/server.js"));
  });

  afterEach(async () => {
    await stopBrowserControlServer();
    vi.resetModules();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });
});
