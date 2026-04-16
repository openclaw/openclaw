import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const buildQaTargetImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk qa-channel", () => {
  beforeEach(() => {
    buildQaTargetImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    buildQaTargetImpl.mockReturnValue("qa://main");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      buildQaTarget: buildQaTargetImpl,
      qaChannelPlugin: { id: "qa-channel" },
    });
  });

  it("surfaces runtime seam resolution failures without fallback", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-channel/runtime-api.js");
    });
    const { buildQaTarget } = await import("./qa-channel.js");

    expect(() => buildQaTarget({ chatType: "direct", conversationId: "main" })).toThrow(
      "Unable to resolve bundled plugin public surface qa-channel/runtime-api.js",
    );
  });

  it("keeps the qa facade cold until a value is used", async () => {
    const module = await import("./qa-channel.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(module.qaChannelPlugin.id).toBe("qa-channel");
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledTimes(1);
  });

  it("delegates qa helpers through the bundled runtime seam", async () => {
    const { buildQaTarget, formatQaTarget } = await import("./qa-channel.js");
    const input = { chatType: "direct" as const, conversationId: "main" };

    expect(buildQaTarget(input)).toBe("qa://main");
    expect(formatQaTarget(input)).toBe("qa://main");
    expect(buildQaTargetImpl).toHaveBeenCalledTimes(2);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-channel",
      artifactBasename: "runtime-api.js",
    });
  });
});
