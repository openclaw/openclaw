// Skills refresh follows config publication and consumes the newly published plugin metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  makeSnapshot,
} from "./config-reload.test-support.js";

export function registerSkillsRefreshTests(refreshSkillsDiscoveryMock: ReturnType<typeof vi.fn>) {
  describe("startGatewayConfigReloader skills discovery refresh", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(async () => {
      await closeTestConfigReloaders();
      clearCurrentPluginMetadataSnapshot();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each([
      { path: "skills.allowBundled", config: { skills: { allowBundled: ["gog"] } } },
      { path: "browser.enabled required by a skill", config: { browser: { enabled: false } } },
      { path: "env.vars.PATH", config: { env: { vars: { PATH: "/fixture/bin" } } } },
    ])("refreshes after publishing $path", async ({ config }) => {
      const nextConfig: OpenClawConfig = { gateway: { reload: {} }, ...config };
      const readSnapshot = vi.fn(async () =>
        makeSnapshot({ config: nextConfig, hash: "skills-config-change" }),
      );
      const order: string[] = [];
      const previousMetadata = createPluginMetadataSnapshotFixture();
      const publishedMetadata = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "published-skills", skills: ["skills"] }],
      });
      setGatewayPluginMetadataSnapshot(previousMetadata);
      let acceptedConfig: OpenClawConfig | undefined;
      refreshSkillsDiscoveryMock.mockImplementation(({ config: candidateConfig }) => {
        expect(candidateConfig).toEqual(acceptedConfig);
        order.push("skills");
      });
      const { watcher, reloader } = createReloaderHarness(readSnapshot, {
        runTransaction: (run) => withPluginCache(createPluginCache(), run),
        onConfigAccepted: async (candidateConfig) => {
          acceptedConfig = candidateConfig;
          setGatewayPluginMetadataSnapshot(publishedMetadata, { config: candidateConfig });
          order.push("config");
        },
      });
      await reloader.ready;

      watcher.emit("change");
      await flushReload(reloader);

      expect(order).toEqual(["config", "skills"]);
      expect(refreshSkillsDiscoveryMock).toHaveBeenCalledExactlyOnceWith({
        config: nextConfig,
        reason: "config-change",
        pluginMetadataSnapshot: publishedMetadata,
      });
      await reloader.stop();
    });

    it("keeps an applied config when discovery refresh fails", async () => {
      refreshSkillsDiscoveryMock.mockRejectedValue(new Error("discovery unavailable"));
      const nextConfig: OpenClawConfig = {
        gateway: { reload: {} },
        skills: { allowBundled: ["gog"] },
      };
      const { watcher, log, reloader, onConfigAccepted } = createReloaderHarness(async () =>
        makeSnapshot({ config: nextConfig, hash: "skills-refresh-failure" }),
      );
      await reloader.ready;

      watcher.emit("change");
      await flushReload(reloader);

      expect(onConfigAccepted).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledWith(
        "config applied, but skills discovery refresh failed: Error: discovery unavailable",
      );
      expect(log.error).not.toHaveBeenCalled();
      await reloader.stop();
    });

    it("does not refresh skills for a config left unapplied by reload mode off", async () => {
      const initialConfig: OpenClawConfig = { gateway: { reload: { mode: "off" } } };
      const { watcher, reloader } = createReloaderHarness(
        async () =>
          makeSnapshot({
            config: { ...initialConfig, skills: { allowBundled: ["gog"] } },
            hash: "skills-not-applied",
          }),
        { initialConfig },
      );
      await reloader.ready;

      watcher.emit("change");
      await flushReload(reloader);

      expect(refreshSkillsDiscoveryMock).not.toHaveBeenCalled();
      await reloader.stop();
    });
  });
}
