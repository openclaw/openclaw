import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "./test-port.js";

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

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: mocks.controlPort,
    })),
  };
});

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./routes/index.js", () => ({
  registerBrowserRoutes: vi.fn(() => {}),
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: vi.fn(() => false),
}));

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("./server.js");

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.ensureExtensionRelayForProfiles.mockClear();
  });

  afterEach(async () => {
    await stopBrowserControlServer();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });
});
