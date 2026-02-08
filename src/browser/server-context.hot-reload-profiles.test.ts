import { beforeEach, describe, expect, it, vi } from "vitest";

let cfgProfiles: Record<string, { cdpPort?: number; cdpUrl?: string; color?: string }> = {};

// Simulate module-level cache behavior
let cachedConfig: ReturnType<typeof buildConfig> | null = null;

function buildConfig() {
  return {
    browser: {
      enabled: true,
      color: "#FF4500",
      headless: true,
      defaultProfile: "openclaw",
      profiles: { ...cfgProfiles },
    },
  };
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      // Simulate cache: return cached value if exists
      if (!cachedConfig) {
        cachedConfig = buildConfig();
      }
      return cachedConfig;
    },
    clearConfigCache: () => {
      // Clear the simulated cache
      cachedConfig = null;
    },
    writeConfigFile: vi.fn(async () => { }),
  };
});

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => false),
  isChromeReachable: vi.fn(async () => false),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("launch disabled");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw"),
  stopOpenClawChrome: vi.fn(async () => { }),
}));

vi.mock("./cdp.js", () => ({
  createTargetViaCdp: vi.fn(async () => {
    throw new Error("cdp disabled");
  }),
  normalizeCdpWsUrl: vi.fn((wsUrl: string) => wsUrl),
  snapshotAria: vi.fn(async () => ({ nodes: [] })),
  getHeadersWithAuth: vi.fn(() => ({})),
  appendCdpPath: vi.fn((cdpUrl: string, path: string) => `${cdpUrl}${path}`),
}));

vi.mock("./pw-ai.js", () => ({
  closePlaywrightBrowserConnection: vi.fn(async () => { }),
}));

vi.mock("../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => { }),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
    cachedConfig = null; // Clear simulated cache
    vi.resetModules();
  });

  it("forProfile hot-reloads newly added profiles from config", async () => {
    // Start with only openclaw profile
    const { createBrowserRouteContext } = await import("./server-context.js");
    const { resolveBrowserConfig } = await import("./config.js");
    const { loadConfig, clearConfigCache } = await import("../config/config.js");

    // 1. Prime the cache by calling loadConfig() first
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    
    // Verify cache is primed (without desktop)
    expect(cfg.browser.profiles.desktop).toBeUndefined();
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    const ctx = createBrowserRouteContext({
      getState: () => state,
    });

    // Initially, "desktop" profile should not exist
    expect(() => ctx.forProfile("desktop")).toThrow(/not found/);

    // 2. Simulate adding a new profile to config (like user editing openclaw.json)
    cfgProfiles.desktop = { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" };

    // 3. Verify without clearConfigCache, loadConfig() still returns stale cached value
    const staleCfg = loadConfig();
    expect(staleCfg.browser.profiles.desktop).toBeUndefined(); // Cache is stale!

    // 4. Now forProfile should hot-reload (calls clearConfigCache internally) and find the new profile
    const profileCtx = ctx.forProfile("desktop");
    expect(profileCtx.profile.name).toBe("desktop");
    expect(profileCtx.profile.cdpUrl).toBe("http://127.0.0.1:9222");

    // 5. Verify the new profile was merged into the cached state
    expect(state.resolved.profiles.desktop).toBeDefined();
    
    // 6. Verify cache was cleared - subsequent loadConfig() sees new value
    const freshCfg = loadConfig();
    expect(freshCfg.browser.profiles.desktop).toBeDefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", async () => {
    const { createBrowserRouteContext } = await import("./server-context.js");
    const { resolveBrowserConfig } = await import("./config.js");
    const { loadConfig } = await import("../config/config.js");

    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    const ctx = createBrowserRouteContext({
      getState: () => state,
    });

    // Profile that doesn't exist anywhere should still throw
    expect(() => ctx.forProfile("nonexistent")).toThrow(/not found/);
  });
});
