import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./runtime-plugin-boundary.js");
  vi.resetModules();
});

describe("runtime web channel plugin", () => {
  it("resolves the default auth dir through the light runtime on each call", async () => {
    let authDir = "/tmp/openclaw-default-auth";
    const resolveDefaultWebAuthDir = vi.fn(() => authDir);

    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => ({ resolveDefaultWebAuthDir }),
      resolvePluginRuntimeModulePath: () => "/tmp/light-runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "bundled",
        source: "test",
      }),
    }));

    const { resolveWebChannelAuthDir } = await import("./runtime-web-channel-plugin.js");

    expect(resolveWebChannelAuthDir()).toBe("/tmp/openclaw-default-auth");
    authDir = "/tmp/openclaw-profile-auth";
    expect(resolveWebChannelAuthDir()).toBe("/tmp/openclaw-profile-auth");
    expect(resolveDefaultWebAuthDir).toHaveBeenCalledTimes(2);
  });
});
