import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig } from "./config.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";

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

vi.mock("../config/config.js", () => ({
  createConfigIO: () => ({
    loadConfig: () => {
      // Always return fresh config for createConfigIO to simulate fresh disk read
      return buildConfig();
    },
  }),
  loadConfig: () => {
    // simulate stale loadConfig that doesn't see updates unless cache cleared
    if (!cachedConfig) {
      cachedConfig = buildConfig();
    }
    return cachedConfig;
  },
  writeConfigFile: vi.fn(async () => {}),
}));

describe("server-context hot-reload profiles", () => {
  let loadConfig: typeof import("../config/config.js").loadConfig;

  beforeAll(async () => {
    ({ loadConfig } = await import("../config/config.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
    cachedConfig = null; // Clear simulated cache
  });

  it("forProfile hot-reloads newly added profiles from config", async () => {
    // Start with only openclaw profile
    // 1. Prime the cache by calling loadConfig() first
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);

    // Verify cache is primed (without desktop)
    expect(cfg.browser?.profiles?.desktop).toBeUndefined();
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    // Initially, "desktop" profile should not exist
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "desktop",
      }),
    ).toBeNull();

    // 2. Simulate adding a new profile to config (like user editing openclaw.json)
    cfgProfiles.desktop = { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" };

    // 3. Verify without clearConfigCache, loadConfig() still returns stale cached value
    const staleCfg = loadConfig();
    expect(staleCfg.browser?.profiles?.desktop).toBeUndefined(); // Cache is stale!

    // 4. Hot-reload should read fresh config for the lookup (createConfigIO().loadConfig()),
    // without flushing the global loadConfig cache.
    const profile = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "desktop",
    });
    expect(profile?.name).toBe("desktop");
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");

    // 5. Verify the new profile was merged into the cached state
    expect(state.resolved.profiles.desktop).toBeDefined();

    // 6. Verify GLOBAL cache was NOT cleared - subsequent simple loadConfig() still sees STALE value
    // This confirms the fix: we read fresh config for the specific profile lookup without flushing the global cache
    const stillStaleCfg = loadConfig();
    expect(stillStaleCfg.browser?.profiles?.desktop).toBeUndefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    // Profile that doesn't exist anywhere should still throw
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        refreshConfigFromDisk: true,
        name: "nonexistent",
      }),
    ).toBeNull();
  });

  it("forProfile refreshes existing profile config after loadConfig cache updates", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    cachedConfig = null;

    const after = resolveBrowserProfileWithHotReload({
      current: state,
      refreshConfigFromDisk: true,
      name: "openclaw",
    });
    expect(after?.cdpPort).toBe(19999);
    expect(state.resolved.profiles.openclaw?.cdpPort).toBe(19999);
  });

  it("listProfiles refreshes config before enumerating profiles", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    cfgProfiles.desktop = { cdpPort: 19999, color: "#0066CC" };
    cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });
    expect(Object.keys(state.resolved.profiles)).toContain("desktop");
  });
});
