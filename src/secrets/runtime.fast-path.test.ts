/** Tests secrets runtime fast-path decisions and skip conditions. */
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "./runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";
import { asConfig } from "./runtime.test-support.js";

const { collectConfigAssignmentsMock, resolveRuntimeWebToolsMock, runtimePrepareImportMock } =
  vi.hoisted(() => ({
    collectConfigAssignmentsMock:
      vi.fn<typeof import("./runtime-config-collectors.js").collectConfigAssignments>(),
    resolveRuntimeWebToolsMock: vi.fn<
      typeof import("./runtime-web-tools.js").resolveRuntimeWebTools
    >(async () => ({
      metadata: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
      degradedOwners: [],
      secretOwners: [],
    })),
    runtimePrepareImportMock: vi.fn(),
  }));

function explicitMainRoster() {
  return { agents: { entries: { main: {} } } };
}

function agentConfig(agentDir: string, port?: number) {
  return asConfig({
    agents: { entries: { main: { agentDir } } },
    ...(port === undefined ? {} : { gateway: { port } }),
  });
}

function prepareAgentSnapshot(
  agentDir: string,
  loadAuthStore: () => AuthProfileStore,
  port?: number,
) {
  return prepareSecretsRuntimeSnapshot({
    config: agentConfig(agentDir, port),
    agentDirs: [agentDir],
    loadAuthStore,
  });
}

function prepareSnapshot(
  config: unknown,
  overrides: Omit<Parameters<typeof prepareSecretsRuntimeSnapshot>[0], "config"> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env: {},
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: emptyAuthStore,
    ...overrides,
  });
}

function authStore(key: string): AuthProfileStore {
  return createAuthProfileStoreFixture({
    "openai:default": { type: "api_key", provider: "openai", key },
  });
}

const startupRoots: string[] = [];

async function createStartupStore(inherited = false) {
  const { prepareSharedAuthStoreOwnershipForNative } =
    await import("../agents/auth-profiles/path-resolve.native.js");
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-fast-path-"));
  startupRoots.push(root);
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const agentDir = path.join(root, "custom-agent");
  mkdirSync(agentDir, { recursive: true });
  if (inherited) {
    writeAuthProfileStore(path.join(root, "agents", "main", "agent"));
  }
  prepareSharedAuthStoreOwnershipForNative(env);
  return { agentDir, env, config: agentConfig(agentDir) };
}

vi.mock("./runtime-prepare.runtime.js", () => {
  runtimePrepareImportMock();
  return {
    createResolverContext: ({
      sourceConfig,
      env,
      manifestRegistry,
    }: {
      sourceConfig: unknown;
      env: unknown;
      manifestRegistry?: unknown;
    }) => ({
      sourceConfig,
      env,
      cache: {},
      ...(manifestRegistry ? { manifestRegistry } : {}),
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    }),
    collectConfigAssignments: collectConfigAssignmentsMock,
    collectAuthStoreAssignments: () => undefined,
    resolveRuntimeWebTools: resolveRuntimeWebToolsMock,
  };
});

vi.mock("./runtime-owner-assignments.js", () => ({
  listSecretAssignmentOwners: () => [],
  resolveAndApplySecretAssignments: async () => ({
    degradedOwners: [],
    resolvedValues: new Map(),
  }),
}));

function emptyAuthStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

function writeAuthProfileStore(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  saveAuthProfileStore(authStore("sk-test"), agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

describe("secrets runtime fast path", () => {
  afterEach(() => {
    collectConfigAssignmentsMock.mockReset();
    runtimePrepareImportMock.mockClear();
    resolveRuntimeWebToolsMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    closeOpenClawAgentDatabasesForTest();
    for (const root of startupRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the fast path when web fetch only configures runtime limits", async () => {
    const snapshot = await prepareSnapshot({
      ...explicitMainRoster(),
      tools: { web: { fetch: { enabled: true, maxChars: 200_000, maxCharsCap: 2_000_000 } } },
      plugins: { enabled: true, allow: [], entries: {} },
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
    expect(snapshot.webTools.fetch.providerSource).toBe("none");
  });

  it("uses the fast path when web fetch is explicitly disabled", async () => {
    await prepareSnapshot({
      ...explicitMainRoster(),
      tools: { web: { fetch: { enabled: false, maxChars: 200_000 } } },
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
  });

  it("keeps explicit web fetch provider config on the resolver path", async () => {
    await prepareSnapshot({
      ...explicitMainRoster(),
      tools: { web: { fetch: { provider: "firecrawl" } } },
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
  });

  it("reuses published plugin metadata without reopening manifests for configured web search", async () => {
    const { collectConfigAssignments } = await import("./runtime-config-collectors.js");
    const { resolveRuntimeWebTools } = await import("./runtime-web-tools.js");
    const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
    const { setCurrentPluginMetadataSnapshot } =
      await import("../plugins/current-plugin-metadata.test-support.js");
    const { listAgentWorkspaceDirs } = await import("../agents/workspace-dirs.js");
    const config = asConfig({
      ...explicitMainRoster(),
      tools: { web: { search: { provider: "webiq" } } },
      plugins: {
        enabled: true,
        allow: ["workiq-code-mode", "tools-code-mode", "webiq", "diagnostics-otel", "brave"],
        entries: {
          "workiq-code-mode": { config: { enabledNamespaces: ["m365", "search"] } },
          "tools-code-mode": { enabled: true },
          webiq: { enabled: true, config: { webSearch: { omitAuth: true, region: "US" } } },
          "diagnostics-otel": { enabled: true },
        },
      },
    });
    const workspaceDir = listAgentWorkspaceDirs(config, process.env)[0];
    const metadataContext = { config, env: process.env, workspaceDir };
    const pluginMetadataSnapshot = loadPluginMetadataSnapshot(metadataContext);
    expect(pluginMetadataSnapshot.plugins.length).toBeGreaterThan(0);
    setCurrentPluginMetadataSnapshot(pluginMetadataSnapshot, metadataContext);
    collectConfigAssignmentsMock.mockImplementationOnce(collectConfigAssignments);
    resolveRuntimeWebToolsMock.mockImplementationOnce(resolveRuntimeWebTools);
    const openSyncSpy = vi.spyOn(fs, "openSync");
    const probeDescriptor = fs.openSync(pluginMetadataSnapshot.plugins[0]!.manifestPath, "r");
    fs.closeSync(probeDescriptor);
    expect(openSyncSpy).toHaveBeenCalledOnce();
    openSyncSpy.mockClear();

    try {
      const snapshot = await prepareSnapshot(config, { env: process.env });

      const manifestOpens = openSyncSpy.mock.calls.filter(
        ([filePath]) => typeof filePath === "string" && filePath.endsWith("/openclaw.plugin.json"),
      );
      expect(snapshot.webTools.search.diagnostics).toEqual(expect.any(Array));
      expect(manifestOpens).toHaveLength(0);
    } finally {
      openSyncSpy.mockRestore();
      setCurrentPluginMetadataSnapshot(undefined);
    }
  });

  it("skips the startup-only fast path when the inherited main auth store exists", async () => {
    const { config, env } = await createStartupStore(true);
    expect(prepareSecretsRuntimeFastPathSnapshot({ config, env })).toBeNull();
  });

  it("publishes owner writes after a startup-only fast path and preserves them on refresh", async () => {
    const { ensureAuthProfileStoreWithoutExternalProfiles } =
      await import("../agents/auth-profiles/store-runtime.js");
    const { activateSecretsRuntimeSnapshotState, getActiveSecretsRuntimeSnapshotState } =
      await import("./runtime-state.js");
    const { config, env, agentDir } = await createStartupStore();
    const fastPath = prepareSecretsRuntimeFastPathSnapshot({ config, env });

    expect(fastPath).not.toBeNull();
    activateSecretsRuntimeSnapshotState({
      snapshot: fastPath!.snapshot,
      refreshContext: fastPath!.refreshContext,
      refreshHandler: null,
    });
    writeAuthProfileStore(agentDir);

    expect(
      ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles["openai:default"],
    ).toMatchObject({ type: "api_key", provider: "openai", key: "sk-test" });

    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
    const active = getActiveSecretsRuntimeSnapshotState();
    expect(active?.authStores[0]?.agentDir).toBe(agentDir);
    expect(active?.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-test",
    });
  });

  it("does not let an active refresh overwrite a snapshot published during preparation", async () => {
    const agentDir = "/tmp/openclaw-agent-refresh-cas";
    let publishNewerSnapshot = false;
    let newerSnapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>> | null = null;
    const loadInitialAuthStore = () => {
      if (publishNewerSnapshot && newerSnapshot) {
        publishNewerSnapshot = false;
        activateSecretsRuntimeSnapshot(newerSnapshot);
      }
      return emptyAuthStore();
    };
    const initialSnapshot = await prepareAgentSnapshot(agentDir, loadInitialAuthStore, 19_001);
    activateSecretsRuntimeSnapshot(initialSnapshot);
    newerSnapshot = await prepareAgentSnapshot(agentDir, emptyAuthStore, 19_002);

    publishNewerSnapshot = true;
    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig.gateway?.port).toBe(19_002);
  });

  it("does not let an active refresh overwrite auth stores mutated during preparation", async () => {
    const { getRuntimeAuthProfileStoreSnapshotCore, setRuntimeAuthProfileStoreSnapshot } =
      await import("../agents/auth-profiles/runtime-snapshots.js");
    const agentDir = "/tmp/openclaw-agent-auth-store-refresh-cas";
    const oldStore = authStore("sk-old");
    const newStore = authStore("sk-new");
    let mutateDuringRefresh = false;
    const loadAuthStore = () => {
      if (mutateDuringRefresh) {
        mutateDuringRefresh = false;
        setRuntimeAuthProfileStoreSnapshot(newStore, agentDir);
        return oldStore;
      }
      return getRuntimeAuthProfileStoreSnapshotCore(agentDir) ?? oldStore;
    };
    const initial = await prepareAgentSnapshot(agentDir, loadAuthStore);
    activateSecretsRuntimeSnapshot(initial);

    mutateDuringRefresh = true;
    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    expect(
      getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles["openai:default"],
    ).toMatchObject({ key: "sk-new" });
    expect(
      getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
    ).toMatchObject({
      key: "sk-new",
    });
  });

  it("re-prepares a preflighted config refresh after its snapshot revision goes stale", async () => {
    const { getRuntimeConfigSnapshotRefreshHandler } =
      await import("../config/runtime-snapshot.js");
    const agentDir = "/tmp/openclaw-agent-preflight-cas";
    const initial = await prepareAgentSnapshot(agentDir, () => authStore("old-key"), 19_011);
    activateSecretsRuntimeSnapshot(initial);
    const concurrent = await prepareAgentSnapshot(agentDir, () => authStore("new-key"), 19_012);
    const staleRefreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    if (!staleRefreshHandler?.preflight) {
      throw new Error("expected active runtime refresh preflight handler");
    }
    const desiredConfig = agentConfig(agentDir, 19_013);
    const preflightResult = await staleRefreshHandler.preflight({
      sourceConfig: desiredConfig,
    });
    activateSecretsRuntimeSnapshot(concurrent);

    await expect(
      staleRefreshHandler.refresh({ sourceConfig: desiredConfig, preflightResult }),
    ).resolves.toBe(true);

    const activeStore = getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store;
    expect(activeStore?.profiles["openai:default"]).toMatchObject({ key: "new-key" });
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig.gateway?.port).toBe(19_013);
  });
});
