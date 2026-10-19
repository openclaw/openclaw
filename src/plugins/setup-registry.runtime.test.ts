import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
} from "./bundled-discovery-state.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
type Runtime = typeof import("./setup-registry.runtime.js");
type Descriptor = ReturnType<Runtime["resolvePluginSetupCliBackendDescriptor"]>;
type Fixture = NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>;

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const current = await import("./current-plugin-metadata-snapshot.js");
  return {
    ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
    loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
    resolvePluginMetadataSnapshot: (
      params: Parameters<typeof current.getCurrentPluginMetadataSnapshot>[0] & {
        allowWorkspaceScopedCurrent?: boolean;
      },
    ) =>
      current.getCurrentPluginMetadataSnapshot({
        config: params.config,
        env: params.env,
        workspaceDir: params.workspaceDir,
        allowWorkspaceScopedSnapshot: params.allowWorkspaceScopedCurrent,
      }) ?? loadPluginMetadataSnapshotMock(params),
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    loadPluginMetadataSnapshotMock.mockReset();
    vi.restoreAllMocks();
    for (const stateDir of tempDirs.dirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    cleanup();
  }),
);

function metadata(...plugins: Fixture["plugins"]) {
  return createPluginMetadataSnapshotFixture({ plugins });
}

function scoped<T extends { restore(): void }>(resource: T) {
  return Object.assign(resource, { [Symbol.dispose]: () => resource.restore() });
}

function expectBackend(actual: Descriptor, pluginId: string, id: string) {
  expect(actual).toEqual({ pluginId, backend: { id } });
}

function currentSnapshot(hash: string, backend: string, workspaceDir?: string) {
  const snapshot = metadata({
    id: "openai",
    rootDir: `/tmp/openai-${hash}`,
    cliBackends: [backend],
  });
  snapshot.index.policyHash = snapshot.policyHash = resolveInstalledPluginIndexPolicyHash({});
  return Object.assign(snapshot, { configFingerprint: hash, workspaceDir });
}

describe("setup-registry descriptor lookup", () => {
  it("keeps prepared CLI activation in the caller's machine-state root", async () => {
    const {
      resolvePluginSetupCliBackendDescriptor: descriptor,
      resolvePluginSetupCliBackendIds: ids,
    } = await import("./setup-registry.runtime.js");
    const compatRoot = tempDirs.make("openclaw-cli-compat-");
    const strictRoot = tempDirs.make("openclaw-cli-strict-");
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      await using cache = createPluginCache();
      setTestEnvValue("OPENCLAW_STATE_DIR", strictRoot);
      const compatEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
      const strictEnv = { ...process.env };
      writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: compatEnv });
      writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env: strictEnv });
      clearBundledDiscoveryModeMemo();
      await withPluginCache(cache, async () => {
        const snapshot = metadata({
          id: "bundled-cli-owner",
          providers: ["fixture-provider"],
          cliBackends: ["scope-cli"],
        });
        snapshot.index.plugins[0]!.contributions = {
          channels: [],
          channelConfigs: [],
          providers: snapshot.plugins[0]!.providers,
          modelCatalogProviders: [],
          modelSupportPrefixes: [],
          modelSupportPatterns: [],
          autoEnableProviderIds: [],
          commandAliases: [],
          contracts: {},
        };
        const config = { plugins: { allow: ["other-owner"] } };
        await prepareBundledDiscoveryMode(compatEnv);
        await prepareBundledDiscoveryMode(strictEnv);
        using sql = scoped(observeMainThreadSql());
        sql.calibrate();
        for (const env of [compatEnv, strictEnv, compatEnv]) {
          const enabled = env === compatEnv;
          const params = { config, env, metadataSnapshot: snapshot };
          expect(descriptor({ ...params, backend: "scope-cli" })).toEqual(
            enabled ? { pluginId: "bundled-cli-owner", backend: { id: "scope-cli" } } : undefined,
          );
          expect(ids(params)).toEqual(enabled ? ["scope-cli"] : []);
        }
        sql.expectIdle();
      });
    } finally {
      envSnapshot.restore();
    }
  });

  it("preserves declaration order across case-equivalent owners and setup contributions", async () => {
    const {
      resolvePluginSetupCliBackendDescriptor: descriptor,
      resolvePluginSetupCliBackendIds: ids,
    } = await import("./setup-registry.runtime.js");
    const snapshot = metadata(
      { id: "first-owner", cliBackends: ["Shared-CLI"] },
      {
        id: "second-owner",
        cliBackends: ["shared-cli"],
        setup: { cliBackends: ["shared-cli", "SHARED-CLI", "setup-cli"] },
      },
      { id: "third-owner", cliBackends: ["Shared-CLI"] },
    );
    const config = { plugins: { entries: { "first-owner": { enabled: false } } } };
    const orderedIds = ["shared-cli", "shared-cli", "SHARED-CLI", "setup-cli", "Shared-CLI"];
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expectBackend(descriptor({ backend: "SHARED-CLI", config }), "second-owner", "shared-cli");
        expect(ids({ config })).toEqual(orderedIds);
        expectBackend(descriptor({ backend: "SETUP-CLI", config }), "second-owner", "setup-cli");
      },
      { trustConfigIdentity: true },
    );
  });

  it("keeps descriptors inside a narrower scoped view of the same metadata generation", async () => {
    const { resolvePluginSetupCliBackendDescriptor: descriptor } =
      await import("./setup-registry.runtime.js");
    const snapshot = currentSnapshot("scoped", "Scoped-CLI");
    const narrowed = projectPluginMetadataSnapshot(snapshot, []);
    const resolve = (view: PluginMetadataSnapshot) =>
      withPluginMetadataSnapshotScope(view, () => descriptor({ backend: "scoped-cli" }), {
        trustConfigIdentity: true,
      });

    expectBackend(resolve(snapshot), "openai", "Scoped-CLI");
    expect(resolve(narrowed)).toBeUndefined();
    expectBackend(resolve(snapshot), "openai", "Scoped-CLI");
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses workspace-scoped current metadata through the active plugin runtime", async () => {
    const { resolvePluginSetupCliBackendDescriptor: descriptor } =
      await import("./setup-registry.runtime.js");

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      "workspace-a",
      "gateway-bindable",
      "/workspace/a",
    );
    for (const [manifestHash, backend, missing] of [
      ["alpha", "Codex-CLI", "next-cli"],
      ["bravo", "Next-CLI", "codex-cli"],
    ] as const) {
      setCurrentPluginMetadataSnapshot(currentSnapshot(manifestHash, backend, "/workspace/a"), {
        config: {},
        env: process.env,
      });
      expectBackend(descriptor({ backend: backend.toLowerCase(), config: {} }), "openai", backend);
      expect(descriptor({ backend: missing, config: {} })).toBeUndefined();
    }

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });
});
