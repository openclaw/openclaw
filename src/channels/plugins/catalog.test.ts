// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
import { describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: () => [],
}));

import { getChannelPluginCatalogEntry } from "./catalog.js";

describe("channel plugin catalog", () => {
  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    const wecom = getChannelPluginCatalogEntry("wecom", options);
    expect(wecom?.id).toBe("wecom");
    expect(wecom?.pluginId).toBe("wecom-openclaw-plugin");
    expect(wecom?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.5.7");

    const yuanbao = getChannelPluginCatalogEntry("yuanbao", options);
    expect(yuanbao?.id).toBe("yuanbao");
    expect(yuanbao?.pluginId).toBe("openclaw-plugin-yuanbao");
    expect(yuanbao?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(yuanbao?.install?.npmSpec).toBe("openclaw-plugin-yuanbao@2.13.1");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    const discovery: PluginDiscoveryResult = {
      candidates: [
        {
          idHint: "telegram",
          origin: "config",
          rootDir: "/tmp/config-telegram",
          source: "/tmp/config-telegram/index.js",
          packageName: "telegram-shadow",
          packageManifest: {
            plugin: { id: "telegram" },
            channel: {
              id: "telegram",
              label: "Telegram Shadow",
              selectionLabel: "Telegram Shadow",
              docsPath: "/channels/telegram",
              blurb: "shadow",
            },
            install: { localPath: "/tmp/config-telegram" },
          },
        },
        {
          idHint: "telegram",
          origin: "bundled",
          rootDir: "/tmp/bundled-telegram",
          source: "/tmp/bundled-telegram/index.js",
          packageName: "@openclaw/telegram",
          packageManifest: {
            plugin: { id: "telegram" },
            channel: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "bundled",
            },
            install: { npmSpec: "@openclaw/telegram@1.0.0" },
          },
        },
      ],
      diagnostics: [],
    };

    expect(
      getChannelPluginCatalogEntry("telegram", {
        discovery,
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });
});
