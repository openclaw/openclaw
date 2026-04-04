import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import type { BundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";

const listBundledPluginMetadataMock = vi.hoisted(() =>
  vi.fn<(options?: unknown) => readonly BundledPluginMetadata[]>(() => []),
);

describe("ChannelsSchema bundled runtime loading", () => {
  beforeEach(() => {
    listBundledPluginMetadataMock.mockClear();
    vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
      listBundledPluginMetadata: (options?: unknown) => listBundledPluginMetadataMock(options),
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
      } as unknown as BundledPluginMetadata,
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
