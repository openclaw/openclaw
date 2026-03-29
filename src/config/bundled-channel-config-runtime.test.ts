import { afterEach, describe, expect, it, vi } from "vitest";

describe("bundled channel config runtime", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../channels/plugins/bundled.js");
    vi.doUnmock("../plugins/bundled-plugin-metadata.js");
  });

  it("tolerates an unavailable bundled channel list during import", async () => {
    vi.doMock("../channels/plugins/bundled.js", () => ({
      listBundledChannelPlugins: () => undefined,
    }));

    const runtimeModule = await import("./bundled-channel-config-runtime.js");

    expect(runtimeModule.getBundledChannelConfigSchemaMap().get("msteams")).toBeDefined();
    expect(runtimeModule.getBundledChannelRuntimeMap().get("msteams")).toBeDefined();
  });

  it("falls back to static channel schemas when bundled plugin access hits a TDZ-style ReferenceError", async () => {
    vi.resetModules();
    vi.doMock("../channels/plugins/bundled.js", () => {
      return {
        listBundledChannelPlugins() {
          throw new ReferenceError("Cannot access 'bundledChannelPlugins' before initialization.");
        },
      };
    });

    const runtime = await import("./bundled-channel-config-runtime.js");
    const configSchemaMap = runtime.getBundledChannelConfigSchemaMap();

    expect(configSchemaMap.has("msteams")).toBe(true);
    expect(configSchemaMap.has("whatsapp")).toBe(true);
  });

  it("does not memoize partial config schema metadata before bundled plugins are readable", async () => {
    vi.resetModules();

    let pluginsReady = false;
    vi.doMock("../channels/plugins/bundled.js", () => ({
      listBundledChannelPlugins: () =>
        pluginsReady
          ? [{ id: "telegram", configSchema: { schema: { type: "object", properties: {} } } }]
          : undefined,
    }));
    vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
      listBundledPluginMetadata: () =>
        pluginsReady
          ? [
              {
                manifest: {
                  id: "telegram",
                  channelConfigs: {
                    telegram: { schema: { type: "object", properties: {} } },
                  },
                },
              },
            ]
          : [],
    }));

    const runtime = await import("./bundled-channel-config-runtime.js");

    expect(runtime.getBundledChannelConfigSchemaMap().has("telegram")).toBe(false);

    pluginsReady = true;

    expect(runtime.getBundledChannelConfigSchemaMap().has("telegram")).toBe(true);
  });
});
