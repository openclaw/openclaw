import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => {
    throw new Error("read-only config");
  }),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
      },
    }),
  };
});

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: 18789,
      profiles: {},
    })),
  };
});

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

const { startBrowserControlServiceFromConfig, stopBrowserControlService } =
  await import("./control-service.js");

describe("browser control service auth bootstrap failures", () => {
  beforeEach(() => {
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.ensureExtensionRelayForProfiles.mockClear();
  });

  afterEach(async () => {
    await stopBrowserControlService();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServiceFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });
});
