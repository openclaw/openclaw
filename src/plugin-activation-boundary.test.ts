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
    vi.resetModules();
  });

  it("does not load bundled provider plugins on ambient command imports", async () => {
    await import("./agents/cli-session.js");
    await import("./commands/onboard-custom.js");
    await import("./commands/opencode-go-model-default.js");
    await import("./commands/opencode-zen-model-default.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load bundled plugins for config and env detection helpers", async () => {
    const { isChannelConfigured } = await import("./config/channel-configured.js");
    const { resolveEnvApiKey } = await import("./agents/model-auth-env.js");

    expect(isChannelConfigured({}, "whatsapp", {})).toBe(false);
    expect(resolveEnvApiKey("anthropic-vertex", {})).toBeNull();
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("does not load provider plugins for static model id normalization", async () => {
    const { normalizeModelRef } = await import("./agents/model-selection.js");

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
