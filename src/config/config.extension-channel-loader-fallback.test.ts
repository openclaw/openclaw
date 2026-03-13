import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { NextcloudTalkConfigSchema } from "../../extensions/nextcloud-talk/src/config-schema.js";

describe("extension channel validation loader fallback", () => {
  const emptyRegistry = createTestRegistry([]);

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    vi.resetModules();
    vi.doUnmock("../plugins/loader.js");
  });

  it("falls back to plugin loading when no active registry is available", async () => {
    setActivePluginRegistry(emptyRegistry);
    vi.resetModules();
    vi.doMock("../plugins/loader.js", () => ({
      loadOpenClawPlugins: vi.fn(() =>
        createTestRegistry([
          {
            pluginId: "fixture-plugin",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "nextcloud-talk",
                label: "Nextcloud Talk",
                docsPath: "/channels/nextcloud-talk",
              }),
              configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
            },
          },
        ]),
      ),
    }));

    const { validateConfigObjectWithPlugins } = await import("./validation.js");
    const result = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
      channels: {
        "nextcloud-talk": {
          dmPolicy: "open",
          allowFrom: ["alice"],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "channels.nextcloud-talk.allowFrom",
        message:
          'channels.nextcloud-talk.dmPolicy="open" requires channels.nextcloud-talk.allowFrom to include "*"',
      });
    }
  });
});
