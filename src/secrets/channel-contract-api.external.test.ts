/** Tests external plugin channel secret contract API loading. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  artifact: vi.fn(() => null),
  rejectHardlinks: vi.fn(() => true),
}));

// mock-isolation: Supply only synthetic plugin records from each temporary fixture.
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
}));

// mock-isolation: Keep config discovery scoped to the synthetic plugin registry.
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: (...args: unknown[]) => {
    const snapshot = mocks.metadata(...args);
    return snapshot.manifestRegistry ?? snapshot;
  },
}));

// mock-isolation: Control bundled fallback without loading installed plugin code.
vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: mocks.artifact,
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

function expectOfficialFallback() {
  const api = loadContract({
    channelId: "qqbot",
    config: { channels: { qqbot: { appId: "app" } } },
    loadablePluginOrigins: undefined,
  });
  expect(contractIds(api)).toEqual([
    "channels.qqbot.accounts.*.clientSecret",
    "channels.qqbot.clientSecret",
  ]);
  return api;
}

function writePlugin(params: { pluginId?: string; channelId?: string; directory?: string }) {
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
    channelConfigs: {},
    rootDir,
  };
}

describe("external channel secret contract api", () => {
  beforeEach(() => {
    mocks.metadata.mockReset();
    mocks.artifact.mockClear();
    mocks.rejectHardlinks.mockReset().mockReturnValue(true);
  });

  afterEach(() => cleanupTrackedTempDirs(tempDirs));

  it("keeps a healthy external contract available when another artifact fails to load", () => {
    const broken = writePlugin({ pluginId: "custom", channelId: "custom" });
    const healthy = writePlugin({ pluginId: "custom-alt", channelId: "custom" });
    fs.writeFileSync(
      path.join(broken.rootDir, "secret-contract-api.cjs"),
      'throw new Error("contract dependency unavailable");\n',
    );
    usePlugins(broken, healthy);

    const api = loadChannelSecretContractApi({ channelId: "custom", config: {}, env: {} });

    expect(contractIds(api)).toEqual(["channels.custom.token"]);
  });

  it("loads dist/ secret-contract-api sidecars for compiled npm-published external channel plugins", () => {
    const record = writePlugin({ directory: "dist" });
    usePlugins(record);
    const contractApi = loadContract();
    expect(contractIds(contractApi)).toContain("channels.discord.token");
    expect(contractApi?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it.runIf(process.platform !== "win32")(
    "loads hardlinked external channel contracts when the plugin hardlink policy allows them",
    () => {
      const record = writePlugin({});
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-hardlink-outside",
        tempDirs,
      );
      fs.linkSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        path.join(outsideDir, "secret-contract-api.cjs"),
      );
      mocks.rejectHardlinks.mockReturnValue(false);
      const env = { OPENCLAW_NIX_MODE: "1" };
      usePlugins(record);
      const api = loadContract({ env });

      expect(mocks.rejectHardlinks).toHaveBeenCalledWith({
        origin: "global",
        rootDir: record.rootDir,
        env,
      });
      expect(contractIds(api)).toContain("channels.discord.token");
    },
  );

  it("skips external channel records outside the loadable plugin origin set", () => {
    const record = writePlugin({});
    usePlugins(record);
    const api = loadContract({ loadablePluginOrigins: new Map([["other", "global"]]) });

    expect(api).toBeUndefined();
  });

  it("falls back to official host secret metadata when an external plugin has no artifact", () => {
    usePlugins();

    const api = expectOfficialFallback();
    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it("falls back to official host secret metadata when plugin metadata is unavailable", () => {
    mocks.metadata.mockImplementation(() => {
      throw new Error("metadata unavailable");
    });

    expectOfficialFallback();
  });
});
