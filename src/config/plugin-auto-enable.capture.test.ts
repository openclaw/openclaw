import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "../plugins/plugin-generation-metrics.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import { preparePluginAutoEnableSetup } from "./plugin-auto-enable.shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["enabled", "readiness", "pending", "allowlist", "preference", "channel"] as const)(
  "captures dependencies only when the %s plugin's setup probe can matter",
  async (mode) => {
    const stateDir = fs.realpathSync(dirs.make("auto-enable-capture-"));
    const rootDir = path.join(stateDir, "plugin");
    const dependency = path.join(rootDir, "node_modules", "fixture-dependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "browser", dependencies: { "fixture-dependency": "1" } }),
    );
    fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"fixture-dependency"}');
    for (let index = 0; index < 16; index++) {
      const directory = path.join(dependency, `branch-${index}`, "nested");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "data.txt"), "unneeded dependency bytes");
    }
    const source = path.join(rootDir, "setup-api.cjs");
    fs.writeFileSync(
      source,
      'module.exports = { id: "browser", register(api) { api.registerAutoEnableProbe(() => "browser configured"); } };',
    );
    const manifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "browser",
          origin: "config",
          rootDir,
          source,
          setupSource: source,
          channels: mode === "channel" ? ["fixture-channel"] : [],
          channelCatalogMeta:
            mode === "preference" ? { id: "browser", preferOver: ["other"] } : undefined,
        }),
      ],
      diagnostics: [],
    };
    const config: OpenClawConfig = {
      plugins: {
        allow: mode === "allowlist" ? ["other"] : undefined,
        entries: {
          browser: {
            enabled: mode === "pending" ? undefined : true,
            config: mode === "readiness" ? undefined : {},
          },
        },
      },
    };
    const metrics = createPluginGenerationMetrics();
    await using cache = createPluginCache();
    await withArtifactPreservingStateReads(() =>
      withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, () =>
        withPluginCache(cache, () =>
          withPluginGenerationMetrics(metrics, async () => {
            await preparePluginAutoEnableSetup({ config, env: {}, manifestRegistry });
            const result = applyPluginAutoEnable({ config, env: {}, manifestRegistry });
            expect(result.config.plugins?.entries?.browser?.enabled).toBe(true);
            if (mode === "allowlist") {
              expect(result.config.plugins?.allow).toContain("browser");
            }
            if (mode === "enabled" || mode === "readiness") {
              expect(metrics.dependencyFiles).toBe(0);
              expect(metrics.originalBytes).toBe(0);
            } else {
              expect(metrics.dependencyFiles).toBe(17);
            }
          }),
        ),
      ),
    );
  },
);
