import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "./provider-contract-public-artifacts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("distinguishes missing provider artifacts from artifact initialization failures", async () => {
  const bundledPluginsDir = tempDirs.make("openclaw-provider-contract-artifact-");
  const pluginId = "fixture-provider-contract-failure";
  const pluginDir = path.join(bundledPluginsDir, pluginId);
  const message = "Unable to resolve bundled plugin public surface synthetic dependency failure";
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(pluginDir, "provider-contract-api.cjs"),
    `throw new Error(${JSON.stringify(message)});\n`,
  );
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");

  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    expect(
      resolveBundledExplicitProviderContractsFromPublicArtifacts({
        onlyPluginIds: ["fixture-missing-provider-contract"],
      }),
    ).toBeNull();
    expect(() =>
      resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] }),
    ).toThrowError(new Error(message));
  });
});
