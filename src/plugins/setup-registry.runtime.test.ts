import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
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
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

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

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  loadPluginMetadataSnapshotMock.mockReset();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const stateDir of tempDirs.dirs) {
      closeOpenClawStateDatabaseByPath(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    cleanup();
  }),
);

function createCurrentSnapshot(params: {
  manifestHash: string;
  cliBackends: string[];
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "openai",
        rootDir: `/tmp/openai-${params.manifestHash}`,
        cliBackends: params.cliBackends,
        enabledByDefault: true,
      },
    ],
  });
  snapshot.index.policyHash = policyHash;
  return {
    ...snapshot,
    policyHash,
    configFingerprint: params.manifestHash,
    workspaceDir: params.workspaceDir,
  };
}

describe("setup-registry descriptor lookup", () => {
  it("keeps prepared CLI activation in the caller's machine-state root", async () => {
    const { resolvePluginSetupCliBackendDescriptor, resolvePluginSetupCliBackendIds } =
      await import("./setup-registry.runtime.js");
    const compatRoot = tempDirs.make("openclaw-cli-compat-");
    const strictRoot = tempDirs.make("openclaw-cli-strict-");
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const cache = createPluginCache();
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", strictRoot);
      const compatEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
      const strictEnv = { ...process.env };
      writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: compatEnv });
      writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env: strictEnv });
      clearBundledDiscoveryModeMemo();
      await withPluginCache(cache, async () => {
        const snapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "bundled-cli-owner",
              origin: "bundled",
              providers: ["fixture-provider"],
              cliBackends: ["scope-cli"],
              enabledByDefault: true,
            },
          ],
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
        const sql = observeMainThreadSql();
        try {
          sql.calibrate();
          for (const env of [compatEnv, strictEnv, compatEnv]) {
            const enabled = env === compatEnv;
            const params = { config, env, metadataSnapshot: snapshot };
            expect(
              resolvePluginSetupCliBackendDescriptor({ ...params, backend: "scope-cli" }),
            ).toEqual(
              enabled ? { pluginId: "bundled-cli-owner", backend: { id: "scope-cli" } } : undefined,
            );
            expect(resolvePluginSetupCliBackendIds(params)).toEqual(enabled ? ["scope-cli"] : []);
          }
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      });
    } finally {
      try {
        await retirePluginCache(cache);
      } finally {
        envSnapshot.restore();
      }
    }
  });

  it("preserves declaration order across case-equivalent owners and setup contributions", async () => {
    const { resolvePluginSetupCliBackendDescriptor, resolvePluginSetupCliBackendIds } =
      await import("./setup-registry.runtime.js");
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "first-owner", cliBackends: ["Shared-CLI"] },
        {
          id: "second-owner",
          cliBackends: ["shared-cli"],
          setup: { cliBackends: ["shared-cli", "SHARED-CLI", "setup-cli"] },
        },
        { id: "third-owner", cliBackends: ["Shared-CLI"] },
      ],
    });
    const config = { plugins: { entries: { "first-owner": { enabled: false } } } };
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "SHARED-CLI", config })).toEqual({
          pluginId: "second-owner",
          backend: { id: "shared-cli" },
        });
        expect(resolvePluginSetupCliBackendIds({ config })).toEqual([
          "shared-cli",
          "shared-cli",
          "SHARED-CLI",
          "setup-cli",
          "Shared-CLI",
        ]);
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "SETUP-CLI", config })).toEqual({
          pluginId: "second-owner",
          backend: { id: "setup-cli" },
        });
      },
      { trustConfigIdentity: true },
    );
  });

  it("keeps descriptors inside a narrower scoped view of the same metadata generation", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");
    const snapshot = createCurrentSnapshot({
      manifestHash: "scoped",
      cliBackends: ["Scoped-CLI"],
    });
    const narrowed = projectPluginMetadataSnapshot(snapshot, []);
    const resolve = (view: PluginMetadataSnapshot) =>
      withPluginMetadataSnapshotScope(
        view,
        () => resolvePluginSetupCliBackendDescriptor({ backend: "scoped-cli" }),
        { trustConfigIdentity: true },
      );

    expect(resolve(snapshot)).toEqual({ pluginId: "openai", backend: { id: "Scoped-CLI" } });
    expect(resolve(narrowed)).toBeUndefined();
    expect(resolve(snapshot)).toEqual({ pluginId: "openai", backend: { id: "Scoped-CLI" } });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses workspace-scoped current metadata through the active plugin runtime", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");

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
      setCurrentPluginMetadataSnapshot(
        createCurrentSnapshot({
          manifestHash,
          cliBackends: [backend],
          workspaceDir: "/workspace/a",
        }),
        { config: {}, env: process.env },
      );
      expect(
        resolvePluginSetupCliBackendDescriptor({ backend: backend.toLowerCase(), config: {} }),
      ).toEqual({
        pluginId: "openai",
        backend: { id: backend },
      });
      expect(
        resolvePluginSetupCliBackendDescriptor({ backend: missing, config: {} }),
      ).toBeUndefined();
    }

    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });
});
