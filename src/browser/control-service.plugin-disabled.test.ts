import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ generatedToken: false })),
  createBrowserRuntimeState: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
      },
      plugins: {
        entries: {
          browser: {
            enabled: false,
          },
        },
      },
    }),
  };
});

vi.mock("../../extensions/browser/src/browser/config.js", () => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    controlPort: 18791,
    profiles: { openclaw: { cdpPort: 18800 } },
  })),
}));

vi.mock("../../extensions/browser/src/browser/control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
}));

vi.mock("../../extensions/browser/src/browser/runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: mocks.createBrowserRuntimeState,
  stopBrowserRuntime: vi.fn(async () => {}),
}));

let startBrowserControlServiceFromConfig: typeof import("../../extensions/browser/src/browser/control-service.js").startBrowserControlServiceFromConfig;

describe("startBrowserControlServiceFromConfig", () => {
  beforeEach(async () => {
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.createBrowserRuntimeState.mockClear();
    vi.resetModules();
    ({ startBrowserControlServiceFromConfig } =
      await import("../../extensions/browser/src/browser/control-service.js"));
  });

  it("does not start the default service when the browser plugin is disabled", async () => {
    const started = await startBrowserControlServiceFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
    expect(mocks.createBrowserRuntimeState).not.toHaveBeenCalled();
  });
});
