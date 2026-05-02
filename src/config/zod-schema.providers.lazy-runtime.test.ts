import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestChannelConfig } from "../plugins/manifest.js";

const loadPluginManifestRegistryMock = vi.hoisted(() =>
  vi.fn<(options?: Record<string, unknown>) => PluginManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  })),
);
const collectBundledChannelConfigsMock = vi.hoisted(() =>
  vi.fn<(params: unknown) => Record<string, PluginManifestChannelConfig> | undefined>(
    () => undefined,
  ),
);

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    collectBundledChannelConfigsMock.mockClear();
    vi.doMock("../plugins/plugin-registry.js", () => ({
      loadPluginManifestRegistryForPluginRegistry: (options?: Record<string, unknown>) =>
        loadPluginManifestRegistryMock(options),
    }));
    vi.doMock("../plugins/bundled-channel-config-metadata.js", () => ({
      collectBundledChannelConfigs: (params: unknown) => collectBundledChannelConfigsMock(params),
    }));
  });

  it("skips bundled channel runtime discovery when only core channel keys are present", async () => {
    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-core-only",
    );

    const parsed = runtime.ChannelsSchema.parse({
      defaults: {
        groupPolicy: "open",
      },
      modelByChannel: {
        telegram: {
          primary: "gpt-5.4",
        },
      },
    });

    expect(parsed?.defaults?.groupPolicy).toBe("open");
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        bundledChannelConfigCollector: expect.any(Function),
      }),
    );
  });

  it("loads bundled channel runtime discovery only when plugin-owned channel config is present", async () => {
    loadPluginManifestRegistryMock.mockReturnValueOnce({
      diagnostics: [],
      plugins: [
        {
          id: "discord",
          origin: "bundled",
          channels: ["discord"],
          channelConfigs: {
            discord: {
              runtime: {
                safeParse: (value: unknown) => ({ success: true, data: value }),
              },
            },
          },
        } as unknown as PluginManifestRegistry["plugins"][number],
      ],
    });

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(loadPluginManifestRegistryMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeDisabled: true,
        bundledChannelConfigCollector: expect.any(Function),
      }),
    ]);
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });

  it("loads a single plugin-owned runtime surface when the manifest omits runtime metadata", async () => {
    collectBundledChannelConfigsMock.mockReturnValueOnce({
      discord: {
        schema: {},
        runtime: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
      },
    });
    loadPluginManifestRegistryMock.mockImplementationOnce((options) => ({
      diagnostics: [],
      plugins: [
        {
          id: "discord",
          origin: "bundled",
          channels: ["discord"],
          channelConfigs: (
            options?.bundledChannelConfigCollector as
              | ((params: unknown) => Record<string, PluginManifestChannelConfig> | undefined)
              | undefined
          )?.({
            pluginDir: "/repo/extensions/discord",
            manifest: { id: "discord", channels: ["discord"] },
          }),
        } as unknown as PluginManifestRegistry["plugins"][number],
      ],
    }));

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned-targeted-runtime",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(loadPluginManifestRegistryMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeDisabled: true,
        bundledChannelConfigCollector: expect.any(Function),
      }),
    ]);
    expect(collectBundledChannelConfigsMock).toHaveBeenCalledTimes(1);
  });
});
