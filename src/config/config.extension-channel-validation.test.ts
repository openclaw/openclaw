import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextcloudTalkConfigSchema } from "../../extensions/nextcloud-talk/src/config-schema.js";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("extension channel validation", () => {
  const emptyRegistry = createTestRegistry([]);

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("validates active extension channel config with the channel's safeParse contract", () => {
    const registry = createTestRegistry([
      {
        pluginId: "nextcloud-talk",
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
    ]);
    setActivePluginRegistry(registry);

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
      expect(result.issues.some((issue) => issue.path === "channels.nextcloud-talk")).toBe(false);
    }
  });
});
