import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";

const providersWhatsappImportMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const collectBundledChannelConfigsMock = vi.hoisted(() => vi.fn());

describe("OpenClawSchema startup imports", () => {
  it("validates generic channels without loading provider schemas or runtime metadata", async () => {
    vi.doMock("./zod-schema.providers-whatsapp.js", () => {
      providersWhatsappImportMock();
      return {};
    });
    vi.doMock("../plugins/plugin-metadata-snapshot.js", () => ({
      loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
    }));
    vi.doMock("../plugins/bundled-channel-config-metadata.js", () => ({
      collectBundledChannelConfigs: collectBundledChannelConfigsMock,
    }));
    const runtime = await importFreshModule<typeof import("./zod-schema.js")>(
      import.meta.url,
      "./zod-schema.js?scope=startup-generic-channels",
    );
    const channels = {
      defaults: {
        groupPolicy: "open",
        botLoopProtection: { maxEventsPerWindow: 4, windowSeconds: 90, cooldownSeconds: 30 },
      },
      modelByChannel: { telegram: { primary: "gpt-5.4" } },
      discord: {},
    };
    expect(runtime.OpenClawSchema.parse({ channels }).channels).toEqual(channels);
    expect(providersWhatsappImportMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(collectBundledChannelConfigsMock).not.toHaveBeenCalled();
  });
});
