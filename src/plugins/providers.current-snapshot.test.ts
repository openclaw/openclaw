import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import * as manifestRegistryInstalled from "./manifest-registry-installed.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveUsageHookProviderPluginContracts } from "./providers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function createUsageSnapshot(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "z-usage",
        origin: "global",
        enabledByDefault: false,
        providers: ["usage-alias"],
        contracts: { usageProviders: [" ZETA ", "shared", "shared", "ALPHA"] },
      },
      {
        id: "a-compat",
        enabledByDefault: false,
        providers: ["compat"],
        contracts: { usageProviders: ["compat"] },
      },
      {
        id: "m-disabled",
        origin: "global",
        providers: ["disabled-alias"],
        contracts: { usageProviders: ["disabled"] },
      },
      { id: "b-regular", origin: "global", providers: ["regular"] },
      {
        id: "h-harness",
        origin: "global",
        contracts: { usageProviders: ["harness"] },
      },
    ],
  });
  snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(config, env);
  snapshot.index.policyHash = snapshot.policyHash;
  return snapshot;
}

describe("usage provider metadata snapshots", () => {
  it("reuses the Gateway inventory while applying current alias and activation policy", () => {
    const config: OpenClawConfig = {
      plugins: {
        allow: ["usage-alias", "disabled-alias", "h-harness"],
        entries: { "usage-alias": { enabled: true }, "disabled-alias": { enabled: false } },
      },
    };
    const env = { HOME: "/tmp/openclaw-usage-snapshot", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    setGatewayPluginMetadataSnapshot(createUsageSnapshot(config, env), { config, env });
    const reloadManifests = vi.spyOn(
      manifestRegistryInstalled,
      "loadPluginManifestRegistryForInstalledIndex",
    );
    const readFile = vi.spyOn(fs, "readFileSync");
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const statFile = vi.spyOn(fs, "statSync");

    const initial = resolveUsageHookProviderPluginContracts({ config, env });
    const disabled = resolveUsageHookProviderPluginContracts({
      config: { plugins: { enabled: false } },
      env,
    });

    expect(reloadManifests).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(readDirectory).not.toHaveBeenCalled();
    expect(statFile).not.toHaveBeenCalled();
    expect(initial).toEqual([
      { pluginId: "a-compat", providerIds: ["compat"] },
      { pluginId: "h-harness", providerIds: ["harness"] },
      { pluginId: "z-usage", providerIds: ["alpha", "shared", "zeta"] },
    ]);
    // Bundled provider compatibility remains eligible for usage discovery.
    expect(disabled).toEqual([{ pluginId: "a-compat", providerIds: ["compat"] }]);
  });

  it.each(["absent", "workspace", "environment", "partial"] as const)(
    "uses cold metadata when the operation snapshot is %s",
    (scope) => {
      const root = makeTrackedTempDir("openclaw-usage-metadata", tempDirs);
      const fixture = createColdPluginFixture({
        rootDir: root,
        pluginId: "cold-usage",
        providerId: "cold-provider",
        manifest: { contracts: { usageProviders: ["cold-provider", "cold-provider"] } },
      });
      const config = createColdPluginConfig(root, fixture.pluginId);
      const env = {
        HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const workspaceDir = path.join(root, "workspace");
      if (scope !== "absent") {
        const snapshot = createUsageSnapshot(config, env);
        snapshot.workspaceDir =
          scope === "workspace" ? path.join(root, "other-workspace") : workspaceDir;
        if (scope === "partial") {
          snapshot.pluginIds = ["z-usage"];
        }
        setCurrentPluginMetadataSnapshot(snapshot, {
          config,
          env: scope === "environment" ? { ...env, HOME: path.join(root, "other-home") } : env,
          workspaceDir: snapshot.workspaceDir,
        });
      }

      expect(resolveUsageHookProviderPluginContracts({ config, env, workspaceDir })).toEqual([
        { pluginId: "cold-usage", providerIds: ["cold-provider"] },
      ]);
      expect(
        resolveUsageHookProviderPluginContracts({
          config: { ...config, plugins: { ...config.plugins, enabled: false } },
          env,
          workspaceDir,
        }),
      ).toEqual([]);
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    },
  );
});
