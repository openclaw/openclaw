import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveUsageHookProviderPluginContracts as resolveUsage } from "./providers.js";
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
  const plugins = (
    [
      ["z-usage", "global", ["usage-alias"], [" ZETA ", "shared", "shared", "ALPHA"], false],
      ["a-compat", "bundled", ["compat"], ["compat"], false],
      ["m-disabled", "global", ["disabled-alias"], ["disabled"], undefined],
      ["b-regular", "global", ["regular"], undefined, undefined],
      ["h-harness", "global", [], ["harness"], undefined],
    ] as const
  ).map(([id, origin, providers, usage, enabledByDefault]) => ({
    id,
    origin,
    enabledByDefault,
    providers: [...providers],
    contracts: usage ? { usageProviders: [...usage] } : undefined,
  }));
  return createPluginMetadataSnapshotFixture(
    { plugins },
    resolveInstalledPluginIndexPolicyHash(config, env),
  );
}

it("reuses the Gateway inventory while applying current alias and activation policy", () => {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["usage-alias", "disabled-alias", "h-harness"],
      entries: { "usage-alias": { enabled: true }, "disabled-alias": { enabled: false } },
    },
  };
  const env = { HOME: "/tmp/openclaw-usage-snapshot", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  setGatewayPluginMetadataSnapshot(createUsageSnapshot(config, env), { config, env });
  const reads = (["readFileSync", "readdirSync", "statSync"] as const).map((key) =>
    vi.spyOn(fs, key),
  );

  const initial = resolveUsage({ config, env });
  const disabled = resolveUsage({
    config: { plugins: { enabled: false } },
    env,
  });

  for (const read of reads) {
    expect(read).not.toHaveBeenCalled();
  }
  expect(initial).toEqual([
    { pluginId: "a-compat", providerIds: ["compat"] },
    { pluginId: "h-harness", providerIds: ["harness"] },
    { pluginId: "z-usage", providerIds: ["alpha", "shared", "zeta"] },
  ]);
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

    const request = { config, env, workspaceDir };
    expect(resolveUsage(request)).toEqual([
      { pluginId: "cold-usage", providerIds: ["cold-provider"] },
    ]);
    expect(
      resolveUsage({
        ...request,
        config: { ...config, plugins: { ...config.plugins, enabled: false } },
      }),
    ).toEqual([]);
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  },
);
