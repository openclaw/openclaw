import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./plugin-sdk/facade-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-sdk/facade-runtime.js")>();
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin activation boundary", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  let ambientImportsPromise: Promise<void> | undefined;
  let configHelpersPromise:
    | Promise<{
        isChannelConfigured: typeof import("./config/channel-configured.js").isChannelConfigured;
        resolveEnvApiKey: typeof import("./agents/model-auth-env.js").resolveEnvApiKey;
      }>
    | undefined;
  let modelSelectionPromise:
    | Promise<{
        normalizeModelRef: typeof import("./agents/model-selection.js").normalizeModelRef;
      }>
    | undefined;
  let browserHelpersPromise:
    | Promise<{
        DEFAULT_AI_SNAPSHOT_MAX_CHARS: typeof import("./plugin-sdk/browser-runtime.js").DEFAULT_AI_SNAPSHOT_MAX_CHARS;
        DEFAULT_BROWSER_EVALUATE_ENABLED: typeof import("./plugin-sdk/browser-runtime.js").DEFAULT_BROWSER_EVALUATE_ENABLED;
        DEFAULT_OPENCLAW_BROWSER_COLOR: typeof import("./plugin-sdk/browser-runtime.js").DEFAULT_OPENCLAW_BROWSER_COLOR;
        DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: typeof import("./plugin-sdk/browser-runtime.js").DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME;
        DEFAULT_UPLOAD_DIR: typeof import("./plugin-sdk/browser-runtime.js").DEFAULT_UPLOAD_DIR;
        closeTrackedBrowserTabsForSessions: typeof import("./plugin-sdk/browser-runtime.js").closeTrackedBrowserTabsForSessions;
        parseBrowserMajorVersion: typeof import("./plugin-sdk/browser-runtime.js").parseBrowserMajorVersion;
        redactCdpUrl: typeof import("./plugin-sdk/browser-runtime.js").redactCdpUrl;
        readBrowserVersion: typeof import("./plugin-sdk/browser-runtime.js").readBrowserVersion;
        resolveBrowserConfig: typeof import("./plugin-sdk/browser-runtime.js").resolveBrowserConfig;
        resolveBrowserControlAuth: typeof import("./plugin-sdk/browser-runtime.js").resolveBrowserControlAuth;
        resolveGoogleChromeExecutableForPlatform: typeof import("./plugin-sdk/browser-runtime.js").resolveGoogleChromeExecutableForPlatform;
        resolveProfile: typeof import("./plugin-sdk/browser-runtime.js").resolveProfile;
      }>
    | undefined;
  let browserAmbientImportsPromise: Promise<void> | undefined;
  let discordMaintenancePromise:
    | Promise<{
        unbindThreadBindingsBySessionKey: typeof import("./plugin-sdk/discord-thread-bindings.js").unbindThreadBindingsBySessionKey;
      }>
    | undefined;

  function importAmbientModules() {
    ambientImportsPromise ??= Promise.all([
      import("./agents/cli-session.js"),
      import("./commands/onboard-custom.js"),
      import("./commands/opencode-go-model-default.js"),
      import("./commands/opencode-zen-model-default.js"),
    ]).then(() => undefined);
    return ambientImportsPromise;
  }

  function importConfigHelpers() {
    configHelpersPromise ??= Promise.all([
      import("./config/channel-configured.js"),
      import("./agents/model-auth-env.js"),
    ]).then(([channelConfigured, modelAuthEnv]) => ({
      isChannelConfigured: channelConfigured.isChannelConfigured,
      resolveEnvApiKey: modelAuthEnv.resolveEnvApiKey,
    }));
    return configHelpersPromise;
  }

  function importModelSelection() {
    modelSelectionPromise ??= import("./agents/model-selection.js").then((module) => ({
      normalizeModelRef: module.normalizeModelRef,
    }));
    return modelSelectionPromise;
  }

  function importBrowserHelpers() {
    browserHelpersPromise ??= import("./plugin-sdk/browser-runtime.js").then((module) => ({
      DEFAULT_AI_SNAPSHOT_MAX_CHARS: module.DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      DEFAULT_BROWSER_EVALUATE_ENABLED: module.DEFAULT_BROWSER_EVALUATE_ENABLED,
      DEFAULT_OPENCLAW_BROWSER_COLOR: module.DEFAULT_OPENCLAW_BROWSER_COLOR,
      DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: module.DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
      DEFAULT_UPLOAD_DIR: module.DEFAULT_UPLOAD_DIR,
      closeTrackedBrowserTabsForSessions: module.closeTrackedBrowserTabsForSessions,
      parseBrowserMajorVersion: module.parseBrowserMajorVersion,
      redactCdpUrl: module.redactCdpUrl,
      readBrowserVersion: module.readBrowserVersion,
      resolveBrowserConfig: module.resolveBrowserConfig,
      resolveBrowserControlAuth: module.resolveBrowserControlAuth,
      resolveGoogleChromeExecutableForPlatform: module.resolveGoogleChromeExecutableForPlatform,
      resolveProfile: module.resolveProfile,
    }));
    return browserHelpersPromise;
  }

  function importBrowserAmbientModules() {
    browserAmbientImportsPromise ??= Promise.all([
      import("./agents/sandbox/browser.js"),
      import("./agents/sandbox/context.js"),
      import("./commands/doctor-browser.js"),
      import("./node-host/runner.js"),
      import("./security/audit.js"),
      import("./security/audit-extra.sync.js"),
    ]).then(() => undefined);
    return browserAmbientImportsPromise;
  }

  function importDiscordMaintenance() {
    discordMaintenancePromise ??= import("./plugin-sdk/discord-thread-bindings.js").then(
      (module) => ({
        unbindThreadBindingsBySessionKey: module.unbindThreadBindingsBySessionKey,
      }),
    );
    return discordMaintenancePromise;
  }

  it("does not load bundled provider plugins on ambient command imports", async () => {
    await importAmbientModules();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load bundled plugins for config and env detection helpers", async () => {
    const { isChannelConfigured, resolveEnvApiKey } = await importConfigHelpers();

    expect(isChannelConfigured({}, "whatsapp", {})).toBe(false);
    // Anthropic Vertex auth depends on ambient ADC state on the current machine.
    expect([null, { apiKey: "gcp-vertex-credentials", source: "gcloud adc" }]).toContainEqual(
      resolveEnvApiKey("anthropic-vertex", {}),
    );
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load provider plugins for static model id normalization", async () => {
    const { normalizeModelRef } = await importModelSelection();

    expect(normalizeModelRef("google", "gemini-3.1-pro")).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("xai", "grok-4-fast-reasoning")).toEqual({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load the browser plugin for static browser config helpers", async () => {
    const browser = await importBrowserHelpers();

    expect(browser.DEFAULT_AI_SNAPSHOT_MAX_CHARS).toBe(80_000);
    expect(browser.DEFAULT_BROWSER_EVALUATE_ENABLED).toBe(true);
    expect(browser.DEFAULT_OPENCLAW_BROWSER_COLOR).toBe("#FF4500");
    expect(browser.DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME).toBe("openclaw");
    expect(browser.DEFAULT_UPLOAD_DIR).toContain("uploads");
    expect(browser.parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(browser.resolveBrowserControlAuth({}, {} as NodeJS.ProcessEnv)).toEqual({
      token: undefined,
      password: undefined,
    });
    const resolved = browser.resolveBrowserConfig(undefined, {});
    expect(browser.resolveProfile(resolved, "openclaw")).toEqual(
      expect.objectContaining({
        name: "openclaw",
        cdpHost: "127.0.0.1",
      }),
    );
    expect(
      browser.redactCdpUrl("wss://user:secret@example.com/devtools/browser/123"),
    ).not.toContain("secret");
    expect(browser.readBrowserVersion("/path/that/does/not/exist")).toBeNull();
    expect(browser.resolveGoogleChromeExecutableForPlatform("aix")).toBeNull();
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps browser cleanup helpers cold when browser is disabled", async () => {
    const browser = await importBrowserHelpers();

    await expect(browser.closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps discord cleanup helpers cold when discord is disabled", async () => {
    const discord = await importDiscordMaintenance();

    expect(
      discord.unbindThreadBindingsBySessionKey({
        targetSessionKey: "agent:main:test",
        targetKind: "acp",
        reason: "session-reset",
        sendFarewell: true,
      }),
    ).toEqual([]);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("keeps audited browser ambient imports cold", async () => {
    await importBrowserAmbientModules();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });
});
