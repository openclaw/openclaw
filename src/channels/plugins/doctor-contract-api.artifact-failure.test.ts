// A channel doctor artifact that resolves but fails to initialize is not a missing artifact.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("propagates a bundled channel doctor artifact's own initialization failure", async () => {
  const bundledPluginsDir = tempDirs.make("openclaw-channel-doctor-artifact-");
  const pluginId = "fixture-doctor-contract-failure";
  const pluginDir = path.join(bundledPluginsDir, pluginId);
  const message = "Unable to resolve bundled plugin public surface synthetic dependency failure";
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(pluginDir, "doctor-contract-api.cjs"),
    `throw new Error(${JSON.stringify(message)});\n`,
  );
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");

  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    expect(loadBundledChannelDoctorContractApi("fixture-missing-doctor-contract")).toBeUndefined();
    expect(() => loadBundledChannelDoctorContractApi(pluginId)).toThrowError(new Error(message));
  });
});
