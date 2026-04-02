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

  it("does not load bundled provider plugins on ambient command imports", async () => {
    await importAmbientModules();

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load bundled plugins for config and env detection helpers", async () => {
    const { isChannelConfigured, resolveEnvApiKey } = await importConfigHelpers();

    expect(isChannelConfigured({}, "whatsapp", {})).toBe(false);
    expect(resolveEnvApiKey("anthropic-vertex", {})).toBeNull();
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
});
