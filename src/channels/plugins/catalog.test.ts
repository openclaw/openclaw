import { describe, expect, it } from "vitest";
import { getChannelPluginCatalogEntry } from "./catalog.js";

describe("channel plugin catalog", () => {
  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: { OPENCLAW_PLUGIN_CATALOG_PATHS: "/tmp/openclaw-channel-catalog-no-external.json" },
      discovery: { candidates: [], diagnostics: [] },
      installRecords: {},
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

    const zulip = getChannelPluginCatalogEntry("zulip", options);
    expect(zulip?.id).toBe("zulip");
    expect(zulip?.pluginId).toBe("zulip");
    expect(zulip?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(zulip?.install?.npmSpec).toBe("openclaw-channel-zulip@2026.5.26");
  });
});
