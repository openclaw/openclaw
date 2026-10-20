import { beforeEach, expect, it, vi } from "vitest";
import {
  recordPluginCandidateInstallOwner,
  resolvePluginCandidateInstallOwner,
} from "../plugins/candidate-install-owner.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshotInput: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshotInput,
  resolvePluginMetadataSnapshotInput: mocks.resolvePluginMetadataSnapshotInput,
}));

const { resolveReadOnlyChannelPluginsForConfig } = await import("../channels/plugins/read-only.js");
const { createConfigIoContext } = await import("./io.context.js");
const { resolveConfigWidePluginMetadataSnapshot, resolveConfigWidePluginManifestRegistry } =
  await import("./io.plugin-metadata.js");

const { createCanonicalAgentConfigFixture } = await import("../test-utils/config-roster.js");
const { validateConfigObjectWithPlugins, validateConfigObjectWithPluginsAsync } =
  await import("./validation.js");

const agents = {
  ownership: "explicit" as const,
  entries: {
    ops: { workspace: "/srv/ops" },
    research: { workspace: "/srv/research" },
  },
};

function manifestRecord(id: string, source: string, channels: string[] = []): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    source,
    rootDir: source,
    origin: "workspace",
    channels,
    configSchema: { type: "object", additionalProperties: false },
  });
}

function workspaceSnapshot(
  workspaceDir: string,
  plugins: PluginManifestRecord[],
  disabledIds: readonly string[] = [],
  policyHash = "test",
) {
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  const index = {
    ...snapshot.index,
    workspaceDir,
    policyHash,
    plugins: snapshot.index.plugins.map((plugin) => ({
      ...plugin,
      enabled: !disabledIds.includes(plugin.pluginId),
    })),
  };
  return restorePluginMetadataSnapshot({
    ...snapshot,
    workspaceDir,
    policyHash,
    index,
    registryIndex: index,
    plugins,
    manifestRegistry: { plugins, diagnostics: [] },
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    discovery: {
      candidates: plugins.map((plugin) =>
        recordPluginCandidateInstallOwner(
          {
            idHint: plugin.id,
            source: plugin.source,
            rootDir: plugin.rootDir,
            origin: plugin.origin,
            workspaceDir,
          },
          plugin.id,
        ),
      ),
      diagnostics: [],
    },
  });
}

function metadataLoader() {
  const context = createConfigIoContext({ env: {}, observe: false });
  return context.createValidationPluginMetadataSnapshotLoader({ env: {} });
}

function mockWorkspaces(
  entries: Record<string, ReturnType<typeof workspaceSnapshot> | PluginManifestRecord[]>,
) {
  const snapshots = new Map(
    Object.entries(entries).map(
      ([workspace, entry]) =>
        [workspace, Array.isArray(entry) ? workspaceSnapshot(workspace, entry) : entry] as const,
    ),
  );
  mocks.resolvePluginMetadataSnapshotInput.mockImplementation(
    ({ workspaceDir }: { workspaceDir: string }) => snapshots.get(workspaceDir),
  );
  return snapshots;
}

beforeEach(() => {
  clearCurrentPluginMetadataSnapshot();
  clearPluginMetadataLifecycleCaches();
  mocks.resolvePluginMetadataSnapshotInput.mockReset();
});

it.each(["sync", "async"] as const)(
  "reuses Gateway metadata through %s config validation",
  async (mode) => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: { workspace: "/srv/ops" } } },
      logging: { level: "info" },
      plugins: { allow: ["prepared"] },
    };
    const prepared = manifestRecord("prepared", "/srv/ops/prepared");
    const snapshot = workspaceSnapshot(
      "/srv/ops",
      [prepared],
      [],
      resolveInstalledPluginIndexPolicyHash(config, {}),
    );
    setGatewayPluginMetadataSnapshot(snapshot, { config, env: {} });
    mocks.resolvePluginMetadataSnapshotInput.mockReturnValue(snapshot);
    const nextConfig = { ...config, logging: { level: "debug" } };
    const loader = metadataLoader();

    const result = await withPluginCache(createPluginCache(), () =>
      mode === "sync"
        ? validateConfigObjectWithPlugins(nextConfig, {
            env: {},
            loadPluginMetadataSnapshot: loader.load,
          })
        : validateConfigObjectWithPluginsAsync(nextConfig, {
            env: {},
            loadPluginMetadataSnapshotAsync: loader.loadAsync,
          }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(loader.getSnapshot()).toBe(snapshot);
    expect(mocks.resolvePluginMetadataSnapshotInput).not.toHaveBeenCalled();
  },
);

it("discovers the new workspace when reload changes legacy default ownership", async () => {
  const legacyConfig = (defaultAgent: "ops" | "research") => ({
    plugins: { allow: ["new-workspace-plugin"] },
    agents: {
      defaults: { workspace: "/srv/base" },
      entries: {
        ops: { default: defaultAgent === "ops" },
        research: { default: defaultAgent === "research" },
      },
    },
  });
  const config = createCanonicalAgentConfigFixture(legacyConfig("ops")).config;
  const policyHash = resolveInstalledPluginIndexPolicyHash(config, {});
  const initial = workspaceSnapshot("/srv/base", [], [], policyHash);
  setGatewayPluginMetadataSnapshot(initial, { config, env: {} });
  const added = manifestRecord("new-workspace-plugin", "/srv/base/ops/plugin");
  mockWorkspaces({
    "/srv/base": workspaceSnapshot("/srv/base", [], [], policyHash),
    "/srv/base/ops": workspaceSnapshot("/srv/base/ops", [added], [], policyHash),
  });
  const nextConfig = createCanonicalAgentConfigFixture(legacyConfig("research")).config;
  const loader = metadataLoader();

  const result = await withPluginCache(createPluginCache(), () =>
    validateConfigObjectWithPluginsAsync(nextConfig, {
      env: {},
      loadPluginMetadataSnapshotAsync: loader.loadAsync,
    }),
  );

  expect(result).toMatchObject({ ok: true });
  expect(loader.getSnapshot()?.plugins.map((plugin) => plugin.id)).toEqual([added.id]);
  expect(
    mocks.resolvePluginMetadataSnapshotInput.mock.calls.map(([params]) => params.workspaceDir),
  ).toEqual(["/srv/base/ops", "/srv/base"]);
});

it("feeds merged workspace plugins to snapshot-backed read-only discovery", () => {
  const primary = manifestRecord("primary", "/srv/ops/primary");
  const secondary = manifestRecord("chat", "/srv/research/chat", ["research-chat"]);
  const mergedRegistry = { plugins: [primary, secondary], diagnostics: [] };
  const secondaryDiagnostic = {
    level: "warn" as const,
    code: "persisted-registry-stale-source" as const,
    message: "Retained secondary registry metadata",
  };
  const snapshots = mockWorkspaces({
    "/srv/ops": workspaceSnapshot("/srv/ops", [primary], ["primary"]),
    "/srv/research": {
      ...workspaceSnapshot("/srv/research", [secondary]),
      registryDiagnostics: [secondaryDiagnostic],
    },
  });
  const cfg = {
    agents,
    channels: { "research-chat": { enabled: true } },
    plugins: {
      allow: ["chat"],
      entries: { chat: { enabled: true } },
    },
  };
  const loader = metadataLoader();
  loader.load(cfg);
  const snapshot = loader.getSnapshot();

  const ids = ["primary", "chat"];
  expect(snapshot?.index.plugins.map((plugin) => plugin.pluginId)).toEqual(ids);
  expect(snapshot?.registryIndex).toEqual(snapshots.get("/srv/ops")?.registryIndex);
  expect(snapshot?.registryDiagnostics).toEqual([secondaryDiagnostic]);
  expect(snapshot?.plugins).toEqual(mergedRegistry.plugins);
  expect(structuredClone(snapshot?.manifestRegistry)).toEqual(mergedRegistry);
  expect(snapshot?.index.plugins.find((plugin) => plugin.pluginId === "primary")?.enabled).toBe(
    false,
  );
  expect(snapshot?.byPluginId.get("chat")).toBe(secondary);
  expect(snapshot?.owners.channels.get("research-chat")).toEqual(["chat"]);
  expect(snapshot?.discovery?.candidates.map((candidate) => candidate.workspaceDir)).toEqual([
    "/srv/ops",
    "/srv/research",
  ]);
  expect(snapshot?.discovery?.candidates.map(resolvePluginCandidateInstallOwner)).toEqual(ids);
  expect(Object.isFrozen(snapshot?.index.plugins)).toBe(true);
  expect(
    resolveReadOnlyChannelPluginsForConfig(cfg, {
      env: {},
      metadataSnapshot: snapshot,
    }).plugins.map((plugin) => plugin.id),
  ).toContain("research-chat");
});

it("preserves shared source order and rejects conflicting IDs throughout the inventory", () => {
  const primary = manifestRecord("primary", "/srv/ops/primary");
  const shared = manifestRecord("shared", "/plugins/shared");
  const secondary = manifestRecord("secondary", "/srv/research/secondary");
  mockWorkspaces({
    "/srv/ops": [primary, shared, manifestRecord("conflict", "/srv/ops/conflict")],
    "/srv/research": [secondary, shared, manifestRecord("conflict", "/srv/research/conflict")],
  });

  const snapshot = resolveConfigWidePluginMetadataSnapshot({ config: { agents }, env: {} });

  const ids = ["primary", "shared", "secondary"];
  expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(ids);
  expect(snapshot.index.plugins.map((plugin) => plugin.pluginId)).toEqual(ids);
  expect(snapshot.discovery?.candidates.map((candidate) => candidate.idHint)).toEqual(ids);
  expect(
    structuredClone(
      resolveConfigWidePluginManifestRegistry({ config: { agents }, env: {}, pluginIds: [] }),
    ).plugins,
  ).toEqual([]);
  expect(snapshot.diagnostics).toContainEqual(
    expect.objectContaining({
      level: "error",
      pluginId: "conflict",
      message: expect.stringContaining("present in multiple agent workspaces"),
    }),
  );
});
