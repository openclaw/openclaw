import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

const listBundledPluginMetadataMock = vi.hoisted(() => vi.fn(() => []));

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    listBundledPluginMetadataMock.mockClear();
    vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
      listBundledPluginMetadata: (...args: unknown[]) => listBundledPluginMetadataMock(...args),
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
    expect(listBundledPluginMetadataMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        includeChannelConfigs: true,
      }),
    );
  });

  it("loads bundled channel runtime discovery only when plugin-owned channel config is present", async () => {
    listBundledPluginMetadataMock.mockReturnValueOnce([
      {
        manifest: {
          channelConfigs: {
            discord: {
              runtime: {
                safeParse: (value: unknown) => ({ success: true, data: value }),
              },
            },
          },
        },
      },
    ]);

    const runtime = await importFreshModule<typeof import("./zod-schema.providers.js")>(
      import.meta.url,
      "./zod-schema.providers.js?scope=channels-plugin-owned",
    );

    runtime.ChannelsSchema.parse({
      discord: {},
    });

    expect(listBundledPluginMetadataMock.mock.calls).toContainEqual([
      expect.objectContaining({
        includeChannelConfigs: true,
        includeSyntheticChannelConfigs: true,
      }),
    ]);
  });
});
