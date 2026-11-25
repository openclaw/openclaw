import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { listReadOnlyChannelPluginsForConfig } from "./read-only.js";
import { writeExternalSetupChannelPlugin } from "./read-only.test-support.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([true, false])(
  "writes an aliased channel without changing the source (source present: %s)",
  (sourcePresent) => {
    const { pluginDir, fullMarker } = writeExternalSetupChannelPlugin({
      pluginId: "sibling-plugin",
      channelId: "alpha-chat",
      manifestChannelIds: ["alpha-chat", "beta-chat"],
      setupChannelId: "alpha-chat",
    });
    fs.appendFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `
Object.assign(module.exports.plugin.config, {
  setAccountEnabled({ cfg, enabled }) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "alpha-chat": { token: this.resolveAccount(cfg).token, enabled },
      },
    };
  },
  deleteAccount({ cfg }) {
    const channels = { ...cfg.channels };
    delete channels["alpha-chat"];
    return { ...cfg, channels };
  },
});`,
      "utf8",
    );
    const channels = {
      ...(sourcePresent ? { "alpha-chat": { token: "alpha-token" } } : {}),
      "beta-chat": { token: "beta-token" },
    };
    const cfg: OpenClawConfig = {
      channels,
      plugins: { load: { paths: [pluginDir] }, allow: ["sibling-plugin"] },
    };
    const plugin = listReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    }).find((entry) => entry.id === "beta-chat");
    const enable = plugin?.config.setAccountEnabled;
    const remove = plugin?.config.deleteAccount;
    if (!enable || !remove) {
      throw new Error("Expected cloned channel writers");
    }

    const enabled = enable({ cfg, accountId: "default", enabled: false });
    expect(enabled.channels).toEqual({
      ...(sourcePresent ? { "alpha-chat": { token: "alpha-token" } } : {}),
      "beta-chat": { token: "beta-token", enabled: false },
    });
    expect(remove({ cfg: enabled, accountId: "default" }).channels).toEqual(
      sourcePresent ? { "alpha-chat": { token: "alpha-token" } } : {},
    );
    expect(cfg.channels).toEqual({
      ...(sourcePresent ? { "alpha-chat": { token: "alpha-token" } } : {}),
      "beta-chat": { token: "beta-token" },
    });
    expect(fs.existsSync(fullMarker)).toBe(false);
  },
);
