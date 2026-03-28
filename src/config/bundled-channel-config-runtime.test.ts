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

  it("falls back to static channel schemas when bundled plugin access hits a TDZ-style ReferenceError", async () => {
    vi.resetModules();
    vi.doMock("../channels/plugins/bundled.js", () => {
      const mockModule = {} as { bundledChannelPlugins?: unknown };
      Object.defineProperty(mockModule, "bundledChannelPlugins", {
        enumerable: true,
        get() {
          throw new ReferenceError("Cannot access 'bundledChannelPlugins' before initialization.");
        },
      });
      return mockModule;
    });

    const runtime = await import("./bundled-channel-config-runtime.js");
    const configSchemaMap = runtime.getBundledChannelConfigSchemaMap();

    expect(configSchemaMap.has("msteams")).toBe(true);
    expect(configSchemaMap.has("whatsapp")).toBe(true);
  });
});
