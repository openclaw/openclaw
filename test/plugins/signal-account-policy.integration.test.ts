import path from "node:path";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../src/channels/plugins/types.public.js";
import { withPluginMetadataSnapshotScope } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../src/test-utils/bundled-plugin-public-surface.js";

describe("Signal registered account policy", () => {
  it("uses the selected competing manifest policy in both Signal and core readers", async () => {
    const { signalPlugin } = await loadBundledPluginFacade<{
      signalPlugin: ChannelPlugin<{ config: { account?: string } }>;
    }>({ pluginId: "signal", artifactBasename: "api.js" });
    const loaded = loadPluginManifest(
      path.dirname(
        resolveBundledPluginPublicModulePath({
          pluginId: "signal",
          artifactBasename: "openclaw.plugin.json",
        }),
      ),
    );
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const signal = {
      account: "+12025550123",
      accounts: { "Work Phone": { account: "+12025550124" } },
    };
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "selected-signal-owner", channels: ["signal"] }, loaded.manifest],
    });

    withPluginMetadataSnapshotScope(snapshot, () => {
      const coreAccount = resolveMergedAccountConfig({
        channelId: "signal",
        channelConfig: signal,
        accounts: signal.accounts,
        accountId: "work-phone",
      });
      expect(coreAccount.account).toBe(signal.account);
      expect(
        signalPlugin.config.resolveAccount({ channels: { signal } }, "work-phone").config.account,
      ).toBe(coreAccount.account);
    });
  });
});
