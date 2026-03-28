import { afterEach, describe, expect, it, vi } from "vitest";

describe("bundled channel config runtime", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../channels/plugins/bundled.js");
  });

  it("tolerates an unavailable bundled channel list during import", async () => {
    vi.doMock("../channels/plugins/bundled.js", () => ({
      get bundledChannelPlugins() {
        return undefined;
      },
    }));

    const runtimeModule = await import("./bundled-channel-config-runtime.js");

    expect(runtimeModule.getBundledChannelConfigSchemaMap().get("msteams")).toBeDefined();
    expect(runtimeModule.getBundledChannelRuntimeMap().get("msteams")).toBeDefined();
  });
});
