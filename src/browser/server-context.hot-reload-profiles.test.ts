import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.types.js";

let cfgProfiles: Record<string, { cdpPort?: number; cdpUrl?: string; color?: string }> = {};
let cfgExecutablePath: string | undefined;
let cfgHeadless = true;
let cfgNoSandbox = false;
let cfgDefaultProfile = "openclaw";
let cfgGatewayPort: number | undefined;
let runtimeConfigSnapshot: ReturnType<typeof buildConfig> | null = null;
let runtimeRefreshState: "idle" | "pending" | "failed" = "idle";

// Simulate module-level cache behavior
let cachedConfig: ReturnType<typeof buildConfig> | null = null;

function buildConfig() {
  return {
    gateway: cfgGatewayPort ? { port: cfgGatewayPort } : undefined,
    browser: {
      enabled: true,
      color: "#FF4500",
      headless: cfgHeadless,
      noSandbox: cfgNoSandbox,
      executablePath: cfgExecutablePath,
      defaultProfile: cfgDefaultProfile,
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
  getRuntimeConfigSnapshot: () => runtimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshState: () => runtimeRefreshState,
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
  let resolveBrowserConfig: typeof import("./config.js").resolveBrowserConfig;
  let resolveProfile: typeof import("./config.js").resolveProfile;
  let refreshResolvedBrowserConfigFromDisk: typeof import("./resolved-config-refresh.js").refreshResolvedBrowserConfigFromDisk;
  let resolveBrowserProfileWithHotReload: typeof import("./resolved-config-refresh.js").resolveBrowserProfileWithHotReload;

  beforeEach(async () => {
    vi.resetModules();
    ({ loadConfig } = await import("../config/config.js"));
    ({ resolveBrowserConfig, resolveProfile } = await import("./config.js"));
    ({ refreshResolvedBrowserConfigFromDisk, resolveBrowserProfileWithHotReload } =
      await import("./resolved-config-refresh.js"));
    vi.clearAllMocks();
    cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
    cfgExecutablePath = undefined;
    cfgHeadless = true;
    cfgNoSandbox = false;
    cfgDefaultProfile = "openclaw";
    cfgGatewayPort = undefined;
    runtimeConfigSnapshot = null;
    runtimeRefreshState = "idle";
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

  it("marks existing runtime state for reconcile when profile invariants change", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = resolveProfile(resolved, "openclaw");
    expect(openclawProfile).toBeTruthy();
    const state: BrowserServerState = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "openclaw",
          {
            profile: openclawProfile!,
            running: { pid: 123 } as never,
            lastTargetId: "tab-1",
            reconcile: null,
          },
        ],
      ]),
    };

    cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    const runtime = state.profiles.get("openclaw");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.cdpPort).toBe(19999);
    expect(runtime?.lastTargetId).toBeNull();
    expect(runtime?.reconcile?.reason).toContain("cdpPort");
  });

  it("bypasses stale runtime snapshots so browser route state picks up fresh disk config", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    runtimeConfigSnapshot = buildConfig();
    cfgProfiles.openclaw = { cdpPort: 19999, color: "#FF4500" };
    cfgExecutablePath = "/opt/google/chrome/google-chrome";
    cfgHeadless = false;
    cfgNoSandbox = true;
    cfgDefaultProfile = "desktop";
    cfgProfiles.desktop = { cdpPort: 19998, color: "#0066CC" };

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    expect(state.resolved.profiles.openclaw?.cdpPort).toBe(19999);
    expect(state.resolved.executablePath).toBe("/opt/google/chrome/google-chrome");
    expect(state.resolved.headless).toBe(false);
    expect(state.resolved.noSandbox).toBe(true);
    expect(state.resolved.defaultProfile).toBe("desktop");
  });

  it("keeps runtime-derived defaults stable while hot-reloading browser config from disk", async () => {
    cfgGatewayPort = 4000;
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const previousControlPort = resolved.controlPort;
    const previousCdpPortRangeStart = resolved.cdpPortRangeStart;
    const state = {
      server: null,
      port: 18791,
      resolved,
      profiles: new Map(),
    };

    runtimeConfigSnapshot = buildConfig();

    cfgGatewayPort = 5000;
    cfgExecutablePath = "/opt/google/chrome/google-chrome";
    cfgHeadless = false;
    cfgNoSandbox = true;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      refreshConfigFromDisk: true,
      mode: "cached",
    });

    expect(state.resolved.controlPort).toBe(previousControlPort);
    expect(state.resolved.cdpPortRangeStart).toBe(previousCdpPortRangeStart);
    expect(state.resolved.executablePath).toBe("/opt/google/chrome/google-chrome");
    expect(state.resolved.headless).toBe(false);
    expect(state.resolved.noSandbox).toBe(true);
  });

  it.each(["pending", "failed"] as const)(
    "preserves the last-known-good runtime browser config while refresh is %s",
    async (refreshState) => {
      const cfg = loadConfig();
      const resolved = resolveBrowserConfig(cfg.browser, cfg);
      const state = {
        server: null,
        port: 18791,
        resolved,
        profiles: new Map(),
      };

      runtimeConfigSnapshot = buildConfig();
      runtimeRefreshState = refreshState;

      cfgExecutablePath = "/opt/google/chrome/google-chrome";
      cfgHeadless = false;
      cfgNoSandbox = true;

      refreshResolvedBrowserConfigFromDisk({
        current: state,
        refreshConfigFromDisk: true,
        mode: "cached",
      });

      expect(state.resolved.executablePath).toBeUndefined();
      expect(state.resolved.headless).toBe(true);
      expect(state.resolved.noSandbox).toBe(false);
    },
  );
});
