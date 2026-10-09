// A channel media contract artifact that resolves but fails to initialize is not a missing artifact.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolveChannelInboundAttachmentRootsForChannel } from "./channel-inbound-roots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

const cfg = {
  channels: {},
} as OpenClawConfig;

function installBundledMediaContractFixture(params: {
  artifactSource: string;
  pluginId: string;
}): void {
  const bundledPluginsDir = tempDirs.make("openclaw-channel-media-contract-");
  const pluginDir = path.join(bundledPluginsDir, params.pluginId);
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(path.join(pluginDir, "media-contract-api.cjs"), params.artifactSource);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
}

it("propagates a bundled channel media contract artifact's own initialization failure", async () => {
  const pluginId = "fixture-media-contract-failure";
  const message = "Unable to resolve bundled plugin public surface synthetic dependency failure";
  installBundledMediaContractFixture({
    pluginId,
    artifactSource: `throw new Error(${JSON.stringify(message)});\n`,
  });

  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    expect(() =>
      resolveChannelInboundAttachmentRootsForChannel({ cfg, channelId: pluginId }),
    ).toThrowError(new Error(message));
  });
});

it("still resolves roots from a working bundled channel media contract artifact", async () => {
  const pluginId = "fixture-media-contract-roots";
  installBundledMediaContractFixture({
    pluginId,
    artifactSource:
      'module.exports = { resolveInboundAttachmentRoots: () => ["/fixture/media-roots"] };\n',
  });

  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    expect(resolveChannelInboundAttachmentRootsForChannel({ cfg, channelId: pluginId })).toEqual([
      "/fixture/media-roots",
    ]);
  });
});
