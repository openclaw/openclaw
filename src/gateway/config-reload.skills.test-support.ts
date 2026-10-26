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
  flushWatcherChange,
  makeSnapshot,
} from "./config-reload.test-support.js";

export function registerSkillsRefreshTests(refreshSkillsDiscoveryMock: ReturnType<typeof vi.fn>) {
  const skillsConfig = (): OpenClawConfig => ({
    gateway: { reload: {} },
    skills: { allowBundled: ["gog"] },
  });
  async function reload(
    config: OpenClawConfig,
    options?: Parameters<typeof createReloaderHarness>[1],
  ) {
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config, hash: "skills-change" }),
      options,
    );
    await harness.reloader.ready;
    await flushWatcherChange(harness);
    return harness;
  }
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
      await reload(nextConfig, {
        runTransaction: (run) => withPluginCache(createPluginCache(), run),
        onConfigAccepted: async (candidateConfig) => {
          acceptedConfig = candidateConfig;
          setGatewayPluginMetadataSnapshot(publishedMetadata, { config: candidateConfig });
          order.push("config");
        },
      });
      expect(order).toEqual(["config", "skills"]);
      expect(refreshSkillsDiscoveryMock).toHaveBeenCalledExactlyOnceWith({
        config: nextConfig,
        reason: "config-change",
        pluginMetadataSnapshot: publishedMetadata,
      });
    });

    it("keeps an applied config when discovery refresh fails", async () => {
      refreshSkillsDiscoveryMock.mockRejectedValue(new Error("discovery unavailable"));
      const { log, onConfigAccepted } = await reload(skillsConfig());

      expect(onConfigAccepted).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledWith(
        "config applied, but skills discovery refresh failed: Error: discovery unavailable",
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it("does not refresh skills for a config left unapplied by reload mode off", async () => {
      const initialConfig: OpenClawConfig = { gateway: { reload: { mode: "off" } } };
      await reload({ ...skillsConfig(), ...initialConfig }, { initialConfig });
      expect(refreshSkillsDiscoveryMock).not.toHaveBeenCalled();
    });
  });
}
