import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../channels/plugins/bundled.js");
  vi.resetModules();
});

describe("bundled channel config runtime", () => {
  it("falls back to static channel schemas when bundled plugin mocks omit the plugin list", async () => {
    vi.resetModules();
    vi.doMock("../channels/plugins/bundled.js", () => ({
      bundledChannelPlugins: undefined,
    }));

    const runtime = await import("./bundled-channel-config-runtime.js");
    const configSchemaMap = runtime.getBundledChannelConfigSchemaMap();

    expect(configSchemaMap.has("msteams")).toBe(true);
    expect(configSchemaMap.has("whatsapp")).toBe(true);
  });
});
