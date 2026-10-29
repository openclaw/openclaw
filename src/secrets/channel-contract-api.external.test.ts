/** Tests external plugin channel secret contract API loading. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  rejectHardlinks: vi.fn(() => true),
}));

// mock-isolation: Keep config discovery scoped to the synthetic plugin registry.
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: mocks.metadata,
}));

// mock-isolation: Control bundled fallback without loading installed plugin code.
vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => null,
}));

// mock-isolation: Select each filesystem policy branch independently of the host.
vi.mock("../plugins/hardlink-policy.js", () => ({
  shouldRejectHardlinkedPluginFiles: mocks.rejectHardlinks,
}));

import { loadChannelSecretContractApi } from "./channel-contract-api.js";

function loadContract(options: Partial<Parameters<typeof loadChannelSecretContractApi>[0]> = {}) {
  return loadChannelSecretContractApi({
    channelId: "discord",
    config: { channels: { discord: {} } },
    env: {},
    loadablePluginOrigins: new Map([["discord", "global"]]),
    ...options,
  });
}

const contractIds = (api: ReturnType<typeof loadChannelSecretContractApi>) =>
  api?.secretTargetRegistryEntries?.map(({ id }) => id);
const usePlugins = (...plugins: ReturnType<typeof writePlugin>[]) =>
  mocks.metadata.mockReturnValue({ plugins });

function writePlugin(params: { pluginId?: string; channelId?: string; directory?: string } = {}) {
  const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract", tempDirs);
  const contractDir = path.join(rootDir, params.directory ?? "");
  fs.mkdirSync(contractDir, { recursive: true });
  fs.writeFileSync(
    path.join(contractDir, "secret-contract-api.cjs"),
    `module.exports = {
  secretTargetRegistryEntries: [{ id: "channels.${params.channelId ?? "discord"}.token" }],
  collectRuntimeConfigAssignments() {}
};`,
    "utf8",
  );
  return {
    id: params.pluginId ?? "discord",
    origin: "global",
    channels: [params.channelId ?? "discord"],
    rootDir,
  };
}

describe("external channel secret contract api", () => {
  beforeEach(() => {
    mocks.metadata.mockReset();
    mocks.rejectHardlinks.mockReset().mockReturnValue(true);
  });

  afterEach(() => cleanupTrackedTempDirs(tempDirs));

  it("loads a healthy dist contract after another external artifact fails", () => {
    const broken = writePlugin({ pluginId: "custom", channelId: "custom" });
    const healthy = writePlugin({ pluginId: "custom-alt", channelId: "custom", directory: "dist" });
    fs.writeFileSync(
      path.join(broken.rootDir, "secret-contract-api.cjs"),
      'throw new Error("contract dependency unavailable");\n',
    );
    usePlugins(broken, healthy);

    const api = loadChannelSecretContractApi({ channelId: "custom", config: {}, env: {} });

    expect(contractIds(api)).toEqual(["channels.custom.token"]);
  });

  it.runIf(process.platform !== "win32")(
    "loads hardlinked external channel contracts when the plugin hardlink policy allows them",
    () => {
      const record = writePlugin();
      const outsideDir = makeTrackedTempDir("openclaw-hardlink-outside", tempDirs);
      fs.linkSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        path.join(outsideDir, "secret-contract-api.cjs"),
      );
      mocks.rejectHardlinks.mockReturnValue(false);
      const env = { OPENCLAW_NIX_MODE: "1" };
      usePlugins(record);
      const api = loadContract({ env });

      expect(contractIds(api)).toContain("channels.discord.token");
    },
  );

  it("skips external channel records outside the loadable plugin origin set", () => {
    const record = writePlugin();
    usePlugins(record);
    const api = loadContract({ loadablePluginOrigins: new Map([["other", "global"]]) });

    expect(api).toBeUndefined();
  });

  it.each(["missing artifact", "unavailable metadata"])(
    "uses official metadata with %s",
    (failure) => {
      if (failure === "missing artifact") {
        usePlugins();
      } else {
        mocks.metadata.mockImplementation(() => {
          throw new Error("metadata unavailable");
        });
      }
      const api = loadContract({
        channelId: "qqbot",
        config: { channels: { qqbot: { appId: "app" } } },
        loadablePluginOrigins: undefined,
      });
      expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    },
  );
});
