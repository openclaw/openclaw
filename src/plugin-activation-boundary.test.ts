import { describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() =>
  vi.fn((params: { artifactBasename: string }) => {
    if (params.artifactBasename === "browser-host-inspection.js") {
      return {
        parseBrowserMajorVersion: (raw: string | null | undefined) => {
          const match = raw?.match(/\b(\d+)\./u);
          return match?.[1] ? Number(match[1]) : null;
        },
        readBrowserVersion: () => null,
        resolveGoogleChromeExecutableForPlatform: () => null,
      };
    }
    throw new Error(`unexpected public surface load: ${params.artifactBasename}`);
  }),
);

const facadeMockHelpers = vi.hoisted(() => {
  const createLazyFacadeObjectValue = <T extends object>(load: () => T): T =>
    new Proxy(
      {},
      {
        get(_target, property, receiver) {
          return Reflect.get(load(), property, receiver);
        },
      },
    ) as T;
  const createLazyFacadeArrayValue = <T extends readonly unknown[]>(load: () => T): T =>
    new Proxy([], {
      get(_target, property, receiver) {
        return Reflect.get(load(), property, receiver);
      },
    }) as unknown as T;
  return { createLazyFacadeArrayValue, createLazyFacadeObjectValue };
});

vi.mock("./plugin-sdk/facade-loader.js", () => ({
  ...facadeMockHelpers,
  listImportedBundledPluginFacadeIds: () => [],
  loadBundledPluginPublicSurfaceModuleSync,
  loadFacadeModuleAtLocationSync: vi.fn(),
  resetFacadeLoaderStateForTest: vi.fn(),
}));

vi.mock("./plugin-sdk/facade-runtime.js", () => ({
  ...facadeMockHelpers,
  __testing: {},
  canLoadActivatedBundledPluginPublicSurface: () => true,
  listImportedBundledPluginFacadeIds: () => [],
  loadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSync,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest: vi.fn(),
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync: loadBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin activation boundary", () => {
  let configHelpersPromise:
    | Promise<{
        isStaticallyChannelConfigured: typeof import("./config/channel-configured-shared.js").isStaticallyChannelConfigured;
      }>
    | undefined;
  let modelSelectionPromise:
    | Promise<{
        normalizeModelRef: typeof import("./agents/model-selection-normalize.js").normalizeModelRef;
      }>
    | undefined;
  let browserHelpersPromise:
    | Promise<{
        parseBrowserMajorVersion: typeof import("./plugin-sdk/browser-host-inspection.js").parseBrowserMajorVersion;
      }>
    | undefined;
  function importConfigHelpers() {
    configHelpersPromise ??= import("./config/channel-configured-shared.js").then(
      (channelConfigured) => ({
        isStaticallyChannelConfigured: channelConfigured.isStaticallyChannelConfigured,
      }),
    );
    return configHelpersPromise;
  }

  function importModelSelection() {
    modelSelectionPromise ??= import("./agents/model-selection-normalize.js").then((module) => ({
      normalizeModelRef: module.normalizeModelRef,
    }));
    return modelSelectionPromise;
  }

  function importBrowserHelpers() {
    browserHelpersPromise ??= import("./plugin-sdk/browser-host-inspection.js").then(
      (inspection) => ({
        parseBrowserMajorVersion: inspection.parseBrowserMajorVersion,
      }),
    );
    return browserHelpersPromise;
  }

  it("keeps generic boundaries cold and loads only narrow browser helper surfaces on use", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();

    const [{ isStaticallyChannelConfigured }, { normalizeModelRef }] = await Promise.all([
      importConfigHelpers(),
      importModelSelection(),
    ]);

    expect(isStaticallyChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(
      true,
    );
    expect(isStaticallyChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
    expect(isStaticallyChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(true);
    expect(
      isStaticallyChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
    expect(isStaticallyChannelConfigured({}, "whatsapp", {})).toBe(false);
    const staticNormalize = { allowPluginNormalization: false };
    expect(normalizeModelRef("google", "gemini-3.1-pro", staticNormalize)).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeModelRef("xai", "grok-4-fast-reasoning", staticNormalize)).toEqual({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();

    const browser = await importBrowserHelpers();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(browser.parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
    expect(
      loadBundledPluginPublicSurfaceModuleSync.mock.calls.map(
        ([params]) => params.artifactBasename,
      ),
    ).toEqual(["browser-host-inspection.js"]);
  });
});
