import fs from "node:fs";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getCurrentPluginMetadataSnapshot,
  prepareGatewayPluginMetadataSnapshotPublication,
  runOutsidePluginMetadataSnapshotScope as outsideMetadataScope,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import * as indexPolicy from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import * as controlPlane from "./plugin-control-plane-context.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createProviderExternalAuthResolver } from "./provider-external-auth-core.js";
import { classifyProviderFailoverSignalWithPlugin } from "./provider-failover.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope as getRuntimeScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearCurrentPluginMetadataSnapshot();
  resetPluginRuntimeStateForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSnapshot({
  config,
  normalizationAlias,
  ...scope
}: {
  config?: Parameters<typeof indexPolicy.resolveInstalledPluginIndexPolicyHash>[0];
  pluginIds?: readonly string[];
  normalizationAlias?: string;
  workspaceDir?: string;
} = {}): PluginMetadataSnapshot {
  const snapshot = createPluginMetadataSnapshotFixture(
    {
      plugins: normalizationAlias
        ? [
            {
              id: "fixture",
              modelIdNormalization: {
                providers: { fixture: { aliases: { raw: normalizationAlias } } },
              },
            },
          ]
        : [],
    },
    indexPolicy.resolveInstalledPluginIndexPolicyHash(config),
  );
  return { ...snapshot, ...scope };
}

function expectSnapshot(
  expected: PluginMetadataSnapshot | undefined,
  params: Parameters<typeof getCurrentPluginMetadataSnapshot>[0] = {},
) {
  expect(getCurrentPluginMetadataSnapshot(params)).toBe(expected);
}

function scopedFixture(id: string, workspaceDir = `/workspace/${id}`) {
  const config = { plugins: { allow: [id] } };
  const snapshot = createSnapshot({ config, workspaceDir });
  return {
    config,
    workspaceDir,
    snapshot,
    scope: <T>(run: () => T) => withPluginMetadataSnapshotScope(snapshot, run, { config }),
    runtime: <T>(run: () => T, pluginRegistry?: ReturnType<typeof createEmptyPluginRegistry>) =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot, pluginRegistry }, run),
  };
}

it("carries prepared metadata and registry across nested agent workspaces", async () => {
  const fixture = scopedFixture("scoped", "/workspace/plugins");
  const { config, snapshot: metadataSnapshot, workspaceDir: pluginWorkspaceDir } = fixture;
  const agentWorkspaceDir = "/workspace/agent-run";
  const pluginRegistry = createEmptyPluginRegistry();
  setCurrentPluginMetadataSnapshot(undefined);

  const fingerprint = vi.spyOn(controlPlane, "resolvePluginControlPlaneFingerprint");
  const policyHash = vi.spyOn(indexPolicy, "resolveInstalledPluginIndexPolicyHash");
  await fixture.runtime(async () => {
    await Promise.resolve();
    clearPluginMetadataLifecycleCaches();
    expectSnapshot(metadataSnapshot, { config, workspaceDir: agentWorkspaceDir });
    expectSnapshot(metadataSnapshot, { config, workspaceDir: pluginWorkspaceDir });
    expectSnapshot(metadataSnapshot, {
      config: { plugins: { allow: ["derived-run-policy"] } },
      env: { OPENCLAW_BUNDLED_PLUGINS_DIR: "/plugins/redirected-run" },
      workspaceDir: agentWorkspaceDir,
    });
    expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(true);
    expect(getRuntimeScope()?.pluginRegistry).toBe(pluginRegistry);
  }, pluginRegistry);

  expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(false);
  expectSnapshot(undefined, { config, workspaceDir: agentWorkspaceDir });
  expect(getRuntimeScope()).toBeUndefined();
  expect(fingerprint).not.toHaveBeenCalled();
  expect(policyHash).not.toHaveBeenCalled();
});

it("isolates a registry-less nested generation and restores the outer generation on rejection", async () => {
  const outer = scopedFixture("outer");
  const inner = scopedFixture("inner");
  const outerRegistry = createEmptyPluginRegistry();
  outerRegistry.providers.push({
    pluginId: "outer",
    source: "test",
    provider: { id: "outer", label: "Outer", auth: [], classifyFailoverReason: () => "billing" },
  });
  outerRegistry.trustedToolPolicies = [
    {
      pluginId: "outer",
      pluginName: "Outer",
      source: "test",
      policy: { id: "outer-policy", description: "outer", evaluate: () => undefined },
    },
  ];
  setActivePluginRegistry(outerRegistry, "outer-generation", "default", "/workspace/outer");

  const failover = () =>
    classifyProviderFailoverSignalWithPlugin({
      provider: "outer",
      context: { provider: "outer", errorMessage: "fixture failure" },
    });
  await outer.runtime(async () => {
    await expect(
      inner.runtime(async () => {
        await Promise.resolve();
        expectSnapshot(inner.snapshot, inner);
        expect(getRuntimeScope()?.pluginRegistry).not.toBe(outerRegistry);
        expect(getRuntimeScope()?.pluginRegistry?.providers).toEqual([]);
        expect(resolveProviderRuntimePlugin({ provider: "outer" })).toBeUndefined();
        expect(failover()).toBeUndefined();
        expect(getGlobalHookRunnerRegistry()?.trustedToolPolicies).toEqual([]);
        throw new Error("inner generation failed");
      }),
    ).rejects.toThrow("inner generation failed");

    expectSnapshot(outer.snapshot, outer);
    expect(getRuntimeScope()?.pluginRegistry).toBe(outerRegistry);
    expect(resolveProviderRuntimePlugin({ provider: "outer" })?.id).toBe("outer");
    expect(failover()).toBe("billing");
    expect(
      getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
    ).toEqual(["outer-policy"]);
  }, outerRegistry);

  expectSnapshot(undefined);
  expect(getRuntimeScope()).toBeUndefined();
});

it("lets configless nested readers inherit explicit owner discovery context", () => {
  const config = { plugins: { allow: ["scoped"], load: { paths: ["/plugins/scoped"] } } };
  const snapshot = createSnapshot({ config, workspaceDir: "/workspace/scoped" });
  setCurrentPluginMetadataSnapshot(undefined);

  withPluginMetadataSnapshotScope(
    snapshot,
    () => {
      expectSnapshot(snapshot, { requireDefaultDiscoveryContext: true });
      expectSnapshot(snapshot, { config });
    },
    { config },
  );

  expectSnapshot(undefined, {
    allowWorkspaceScopedSnapshot: true,
    requireDefaultDiscoveryContext: true,
  });
});

it("isolates concurrent owner-prepared metadata scopes", async () => {
  const fixtures = [scopedFixture("first"), scopedFixture("second")];
  const results = await Promise.all(
    fixtures.map((fixture) =>
      fixture.scope(async () => {
        await Promise.resolve();
        return getCurrentPluginMetadataSnapshot(fixture);
      }),
    ),
  );
  results.forEach((result, index) => expect(result).toBe(fixtures[index]?.snapshot));
});

it("falls through nested scopes and restores the parent after rejection", async () => {
  const outer = scopedFixture("outer");
  const inner = scopedFixture("inner");
  setCurrentPluginMetadataSnapshot(undefined);

  await outer.scope(async () => {
    await expect(
      inner.scope(async () => {
        expectSnapshot(outer.snapshot, outer);
        throw new Error("scope failed");
      }),
    ).rejects.toThrow("scope failed");
    expectSnapshot(outer.snapshot, outer);
  });
});

it("invalidates a generic scope when the config identity has a different policy", () => {
  const fixture = scopedFixture("source", "/workspace");
  const { config } = fixture;
  config.plugins.allow = ["runtime"];
  fixture.scope(() => expectSnapshot(undefined, fixture));
});

it("carries published generations through external auth without rehashing their policy", async () => {
  const resolver = createProviderExternalAuthResolver({ resolveProviderPluginsForHooks: () => [] });
  for (const id of ["original", "replacement"]) {
    const config = { plugins: { allow: [id] } };
    const snapshot = createSnapshot({ config });
    setGatewayPluginMetadataSnapshot(snapshot, { config });
    const policyHash = vi.spyOn(indexPolicy, "resolveInstalledPluginIndexPolicyHash");
    const fingerprint = vi.spyOn(controlPlane, "resolvePluginControlPlaneFingerprint");
    try {
      for (let read = 0; read < 3; read++) {
        await resolver.withPreparedExternalAuthProfiles({ config }, async () => {
          await Promise.resolve();
          expectSnapshot(snapshot, { config });
          expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(snapshot)).toBe(true);
        });
      }
      expect(policyHash).not.toHaveBeenCalled();
      expect(fingerprint).not.toHaveBeenCalled();
    } finally {
      policyHash.mockRestore();
      fingerprint.mockRestore();
    }
  }
});

it("lets a projected generic scope fall through to its complete published inventory", () => {
  const config = { plugins: { allow: ["first", "second"] } };
  const snapshot = createPluginMetadataSnapshotFixture(
    { plugins: [{ id: "first" }, { id: "second" }] },
    indexPolicy.resolveInstalledPluginIndexPolicyHash(config),
  );
  setGatewayPluginMetadataSnapshot(snapshot, { config });
  withPluginMetadataSnapshotScope(
    projectPluginMetadataSnapshot(snapshot, ["first"]),
    () => {
      expect(resolvePluginMetadataSnapshot({ config, pluginIds: ["second"] }).pluginIds).toEqual([
        "second",
      ]);
      expect(
        resolvePluginMetadataSnapshot({ config, pluginIds: ["second"] }).plugins.map(
          (plugin) => plugin.id,
        ),
      ).toEqual(["second"]);
    },
    { config },
  );
});

it("keeps prepared metadata usable when the launch directory is removed", () => {
  const config = {};
  const snapshot = createSnapshot({ config });
  setCurrentPluginMetadataSnapshot(snapshot, { config });
  const launchCwd = process.cwd();
  const cwd = vi.spyOn(process, "cwd");
  cwd.mockImplementation(() => {
    throw new Error("ENOENT: uv_cwd");
  });
  expectSnapshot(undefined, { config });
  withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
    expectSnapshot(snapshot, { config });
  });

  cwd.mockReturnValue(launchCwd);
  expectSnapshot(snapshot, { config });
});

it("rejects configless default-discovery reuse for snapshots created with load paths", () => {
  const config = { plugins: { allow: ["demo"], load: { paths: ["/plugins/one"] } } };
  const snapshot = createSnapshot({ config, normalizationAlias: "scoped" });
  setCurrentPluginMetadataSnapshot(snapshot, { config });

  expectSnapshot(undefined, {
    allowWorkspaceScopedSnapshot: true,
    requireDefaultDiscoveryContext: true,
  });
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");

  withPluginMetadataSnapshotScope(createSnapshot({ normalizationAlias: "temporary" }), () => {
    expect(getCurrentPluginMetadataSnapshot()).toBeDefined();
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
  });
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
});

it.each(["supplied", "ambient"] as const)(
  "rejects configless default-discovery reuse when %s bundled-directory trust changes",
  (trustSource) => {
    const overrideRoot = fs.realpathSync(tempDirs.make("openclaw-metadata-bundled-trust-"));
    const env: NodeJS.ProcessEnv = {
      VITEST: "true",
      OPENCLAW_BUNDLED_PLUGINS_DIR: overrideRoot,
    };
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", undefined);

    const snapshot = createSnapshot();
    const originalRoot = resolveBundledPluginsDir(env);
    expect(originalRoot).toBeDefined();
    expect(originalRoot).not.toBe(overrideRoot);
    setCurrentPluginMetadataSnapshot(snapshot, { env });
    const request = { env, requireDefaultDiscoveryContext: true };
    expectSnapshot(snapshot, request);

    withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
      const trustEnv = trustSource === "supplied" ? env : process.env;
      trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      expect(resolveBundledPluginsDir(env)).toBe(overrideRoot);
      expectSnapshot(snapshot, request);
    });

    expectSnapshot(undefined, request);
  },
);

it.each(["explicit", "derived"])("requires exact plugin scope for %s requests", (mode) => {
  const config = { plugins: { allow: ["demo", "other"] } };
  const request =
    mode === "explicit"
      ? { config, pluginIds: ["demo"] }
      : { config, pluginIdScope: { resolve: () => ["demo", "other"] } };
  setCurrentPluginMetadataSnapshot(createSnapshot({ config }), { config });
  expectSnapshot(undefined, request);
  const scoped = createSnapshot({ config, pluginIds: ["other", "demo"] });
  setCurrentPluginMetadataSnapshot(scoped, { config });
  if (mode === "explicit") {
    expectSnapshot(undefined, { config });
    expectSnapshot(scoped, { config, allowScopedSnapshot: true });
    expectSnapshot(scoped, { config, pluginIds: ["demo", "other"] });
    expectSnapshot(undefined, request);
  } else {
    expectSnapshot(scoped, request);
  }
});

it("keeps ordinary metadata within its captured pinned install roots", () => {
  const config = {};
  const snapshot = createSnapshot({ config });
  const roots = {
    extensionsDir: "/plugins/extensions",
    gitDir: "/plugins/git",
    npmDir: "/plugins/npm",
    stateDir: "/plugins/state",
  };
  withPluginInstallRoots(roots, () => {
    setCurrentPluginMetadataSnapshot(snapshot, { config });
    expectSnapshot(snapshot, { config });
    withPluginInstallRoots({ ...roots, npmDir: "/plugins/replacement/npm" }, () => {
      expectSnapshot(undefined, { config });
    });
    expectSnapshot(snapshot, { config });
  });
  expectSnapshot(undefined, { config });
});

it("keeps source-policy compatibility when storing an auto-enabled runtime config", () => {
  const sourceConfig = { channels: { telegram: { botToken: "token" } } };
  const autoEnabledConfig = { ...sourceConfig, plugins: { allow: ["telegram"] } };
  const snapshot = createSnapshot({ config: sourceConfig });
  setCurrentPluginMetadataSnapshot(snapshot, { config: autoEnabledConfig });

  expectSnapshot(snapshot, { config: sourceConfig });
  expectSnapshot(undefined, { config: autoEnabledConfig });
});

it("keeps a scoped reader pinned while a Gateway publication survives scope failure", async () => {
  const original = createSnapshot();
  const scoped = createSnapshot();
  const next = createSnapshot();
  setGatewayPluginMetadataSnapshot(original);
  await expect(
    withPluginMetadataSnapshotScope(scoped, async () => {
      await Promise.resolve();
      outsideMetadataScope(() => setGatewayPluginMetadataSnapshot(next));
      expectSnapshot(scoped);
      expect(outsideMetadataScope(() => getCurrentPluginMetadataSnapshot())).toBe(next);
      throw new Error("scoped operation failed");
    }),
  ).rejects.toThrow("scoped operation failed");
  expectSnapshot(next);
});

it("publishes prepared model policies without enumerating declarations", () => {
  const enumerate = vi.fn((target: object) => Reflect.ownKeys(target));
  const prepare = (alias: string) => {
    const providers = new Proxy(
      { fixture: { aliases: { raw: alias } } },
      { ownKeys: (target) => enumerate(target) },
    );
    return restorePluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "fixture", modelIdNormalization: { providers } }],
      }),
    );
  };
  const original = prepare("original");
  const temporary = prepare("temporary");
  const empty = restorePluginMetadataSnapshot(createPluginMetadataSnapshotFixture());
  const env: NodeJS.ProcessEnv = { HOME: "/home/original-snapshot", OPENCLAW_HOME: undefined };
  enumerate.mockClear();

  setCurrentPluginMetadataSnapshot(original, { env });
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");

  const publishTemporary = prepareGatewayPluginMetadataSnapshotPublication(temporary);
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");
  publishTemporary();
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");
  const publishEmpty = prepareGatewayPluginMetadataSnapshotPublication(empty);
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");
  publishEmpty();
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
  clearCurrentPluginMetadataSnapshot();
  expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
  expect(enumerate).not.toHaveBeenCalled();
});

it("clears the current snapshot when the persisted installed index changes", async () => {
  const tempDir = tempDirs.make("openclaw-plugin-metadata-");
  setCurrentPluginMetadataSnapshot(createSnapshot());

  await writePersistedInstalledPluginIndex(createSnapshot().index, { stateDir: tempDir });

  expectSnapshot(undefined);
});
