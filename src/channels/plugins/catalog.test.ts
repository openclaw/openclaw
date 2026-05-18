import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getChannelPluginCatalogEntry } from "./catalog.js";

describe("channel plugin catalog", () => {
  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-state-"));
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-channel-catalog-workspace-"),
    );
    const options = {
      workspaceDir,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
      },
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
});
