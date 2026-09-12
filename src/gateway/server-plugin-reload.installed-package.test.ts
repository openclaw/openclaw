import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writePersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import type { PluginLifecycleReason } from "../plugins/lifecycle.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { refreshManagedPlugins } from "../plugins/management-mutations.js";
import { resolvePluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  }
});

async function verifyInstalledPackageRetention(settings: "empty" | "defaulted") {
  const bootstrap = await import("./server-plugin-bootstrap.js");
  const root = makeTrackedTempDir("openclaw-gateway-plugin-ledger-reload", tempDirs);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  const writePackage = (id: string) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: id,
      pluginId: id,
      version: "1.0.0",
    });
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        activation: { onStartup: true },
        configSchema:
          id === "sibling"
            ? {
                type: "object",
                additionalProperties: false,
                properties:
                  settings === "defaulted" ? { mode: { type: "string", default: "auto" } } : {},
              }
            : { type: "object" },
      }),
    );
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "A";');
    fs.writeFileSync(
      path.join(packageDir, "dist", "index.js"),
      `const helper = require("./helper.cjs");
const instance = require("node:crypto").randomUUID();
let starts = 0, stops = 0;
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerService({ id: ${JSON.stringify(id)}, start() {
    if (api.pluginConfig?.failStart) throw new Error("synthetic candidate start failed");
    starts++;
  }, stop() { stops++; } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops, settings: api.pluginConfig });
  });
} };`,
    );
    return packageDir;
  };
  await withEnvAsync(env, async () => {
    const siblingDir = writePackage("sibling");
    const initialConfig: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      plugins: {
        allow: ["sibling"],
        entries: { sibling: { enabled: true } },
        load: { paths: [siblingDir] },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const log = { ...createSubsystemLogger("gateway/plugins"), ...logs };
    const initialMetadata = loadPluginMetadataSnapshot({
      config: initialConfig,
      workspaceDir,
      env,
    });
    const initial = bootstrap.prepareGatewayPluginLoad({
      pluginMetadataSnapshot: initialMetadata,
      cfg: initialConfig,
      workspaceDir,
      env,
      log,
      baseMethods: [],
      ambientEnvTriggers: "suppress",
      loadIntent: "startup",
    });
    activatePluginRegistry(initial.pluginRegistry, null, "gateway-bindable", workspaceDir);
    let currentServices: PluginServicesHandle | null = await startPluginServices({
      registry: initial.pluginRegistry,
      config: initialConfig,
      workspaceDir,
    });
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (handle) => {
        currentServices = handle;
      },
    });
    const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, workspaceDir);
    const metadata = retainGatewayPluginMetadata();
    metadata.publish(initialMetadata);
    const loaded = [initial];
    cleanups.push(async () => {
      try {
        await currentServices?.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 });
      } finally {
        for (const generation of loaded) {
          generation.retireGatewayRuntimeBindings?.();
        }
        await registryOwner.close();
        await metadata.close();
      }
    });
    const runtime = {
      pluginMetadataSnapshot: initialMetadata,
      pluginRuntime: registryOwner,
      pluginWorkspaceDir: workspaceDir,
      kernel: {
        pluginRuntimeGeneration: owner,
        pluginMetadata: metadata,
        getCronService: () => runtime.runtimeState.cronState.cron,
      },
      runtimeState: { cronState: {}, gatewayLifetimeSidecars: [] },
      ambientEnvTriggers: "suppress",
      coreGatewayMethodNames: [],
      baseMethods: [],
      channelManager: {
        pauseChannelStarts: () => () => {},
        setAmbientAutostartSuppressedChannelIds: vi.fn(),
      },
      clients: new Set(),
      broadcast: vi.fn(),
    } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    const probe = async (id: string) => {
      const method = `${id}.probe`;
      const respond = vi.fn();
      const handler = runtime.pluginRuntime.registry.gatewayHandlers[method];
      assert.ok(handler, `${method} must be registered`);
      await handler({
        req: { type: "req", id: "ledger-reload", method },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as GatewayRequestHandlerOptions["context"],
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          helper: expect.any(String),
          instance: expect.any(String),
          starts: 1,
          stops: 0,
          settings: expect.any(Object),
        },
        undefined,
        undefined,
      );
      const response = respond.mock.calls[0];
      assert.ok(response);
      return response[1];
    };
    const sibling = await probe("sibling");
    expect(sibling.settings).toEqual(settings === "defaulted" ? { mode: "auto" } : {});
    const siblingRecord = initial.pluginRegistry.plugins.find((record) => record.id === "sibling");
    const siblingHandler = initial.pluginRegistry.gatewayHandlers["sibling.probe"];
    const packageDir = writePackage("installed-probe");
    const config: OpenClawConfig = {
      ...initialConfig,
      plugins: {
        ...initialConfig.plugins,
        allow: ["sibling", "installed-probe"],
        entries: { sibling: { enabled: true }, "installed-probe": { enabled: true } },
      },
    };
    // Managed npm roots live outside discovery directories and are owned by the persisted ledger.
    const writeInstall = (installedAt?: string) =>
      writePersistedInstalledPluginIndexSync(
        loadInstalledPluginIndex({
          config,
          env,
          workspaceDir,
          installRecords: {
            "installed-probe": {
              source: "npm",
              spec: "installed-probe@1.0.0",
              version: "1.0.0",
              installPath: packageDir,
              ...(installedAt ? { installedAt } : {}),
            },
          },
        }),
        { env },
      );
    writeInstall();
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
    const reload = async (
      nextConfig = config,
      pluginIds = ["installed-probe"],
      reason: PluginLifecycleReason = "reload",
      assertInvokerOwned?: () => void,
    ) =>
      await reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => bootstrap,
          prepareAttachedPluginRuntime: async (candidate) => {
            loaded.push(candidate);
            return {
              publish: () => {
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  workspaceDir,
                  runtime.pluginRuntime.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: () => {},
            };
          },
        },
        {
          nextConfig,
          sourceConfig: nextConfig,
          changedPaths: [],
          prepareConfigEffects: () => {},
          assertInvokerOwned,
          pluginLifecycle: {
            reason,
            operationId: "installed-package-reload",
            pluginIds,
          },
          commitRuntime: async (publication) => {
            publication?.publish();
            setRuntimeConfigSnapshot(nextConfig);
            publication?.afterCommit?.();
          },
          env,
        },
      );
    const refresh = () =>
      refreshManagedPlugins({
        env,
        applyRuntime: async ({ config: nextConfig, pluginIds, reason, assertInvokerOwned }) =>
          (await reload(nextConfig, [...pluginIds], reason, assertInvokerOwned)).runtime,
      });
    const validated = validateConfigObjectWithPlugins(config, { env });
    assert.ok(validated.ok);
    expect(validated.config.plugins?.entries?.sibling?.config).toEqual(sibling.settings);
    // Startup uses authored config; the first install applies a validated runtime snapshot.
    const firstReceipt = await reload(validated.config, ["installed-probe"], "install");
    expect(firstReceipt.runtime.pluginIds).toEqual(["installed-probe"]);
    expect(await probe("sibling")).toEqual(sibling);
    const first = await probe("installed-probe");
    expect(first.helper).toBe("A");
    const unchangedReceipt = await refresh();
    expect(await probe("installed-probe")).toEqual(first);
    expect(await probe("sibling")).toEqual(sibling);
    expect(unchangedReceipt.application.pluginIds).toEqual([]);

    // Same-version reinstall changes the committed install input, not the manifest.
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "B";');
    writeInstall("2026-09-07T00:00:00.000Z");
    const changedReceipt = await refresh();
    expect(runtime.pluginMetadataSnapshot?.index.installRecords["installed-probe"]).toMatchObject({
      installedAt: "2026-09-07T00:00:00.000Z",
    });
    const selectedManifest = runtime.pluginMetadataSnapshot?.manifestRegistry.plugins.find(
      (record) => record.id === "installed-probe",
    );
    assert.ok(selectedManifest);
    expect(resolvePluginManifestInstallOwner(selectedManifest)).toBe("installed-probe");
    const updated = await probe("installed-probe");
    expect(updated.helper).toBe("B");
    expect(updated.instance).not.toBe(first.instance);
    expect(changedReceipt.application.pluginIds).toEqual(["installed-probe"]);
    expect(await probe("sibling")).toEqual(sibling);

    // Explicit reload forces the selected owner even when all inputs and bytes match.
    const secondReceipt = await reload();
    const second = await probe("installed-probe");
    expect(second.helper).toBe("B");
    expect(second.instance).not.toBe(updated.instance);
    expect(secondReceipt.runtime.pluginIds).toEqual(["installed-probe"]);
    expect(secondReceipt.runtime.sourceDigests).toEqual(changedReceipt.application.sourceDigests);
    assert.ok(firstReceipt.runtime && secondReceipt.runtime);
    expect(secondReceipt.runtime.generation).toBeGreaterThan(firstReceipt.runtime.generation);
    expect(firstReceipt.runtime.sourceDigests?.["installed-probe"]).toEqual(expect.any(String));
    expect(secondReceipt.runtime.sourceDigests?.["installed-probe"]).not.toBe(
      firstReceipt.runtime.sourceDigests?.["installed-probe"],
    );

    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "C";');
    const sourceOnlyRefresh = await refresh();
    expect(sourceOnlyRefresh.application.pluginIds).toEqual([]);
    expect(await probe("installed-probe")).toEqual(second);
    const sourceOnlyReload = await reload();
    const current = await probe("installed-probe");
    expect(current.helper).toBe("C");
    expect(current.instance).not.toBe(second.instance);
    expect(sourceOnlyReload.runtime.pluginIds).toEqual(["installed-probe"]);
    expect(sourceOnlyReload.runtime.sourceDigests).not.toEqual(secondReceipt.runtime.sourceDigests);

    const lastGoodRegistry = runtime.pluginRuntime.registry;
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), "module.exports = ;");
    await expect(reload()).rejects.toMatchObject({
      details: { phase: "prepare", committed: false, pluginIds: ["installed-probe"] },
    });
    expect(runtime.pluginRuntime.registry).toBe(lastGoodRegistry);
    expect(await probe("installed-probe")).toEqual(current);
    expect(runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling")).toBe(
      siblingRecord,
    );
    expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(siblingHandler);
    expect(await probe("sibling")).toEqual(sibling);

    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "C";');
    const rejectedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          "installed-probe": { enabled: true, config: { failStart: true } },
        },
      },
    };
    // Broad configuration reloads derive their affected owners from candidate identity.
    await expect(reload(rejectedConfig, [])).rejects.toMatchObject({
      details: { phase: "activate", committed: false, pluginIds: ["installed-probe"] },
    });
    expect(runtime.pluginRuntime.registry).toBe(lastGoodRegistry);
    expect(await probe("sibling")).toEqual(sibling);
    const invalidSettings: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: { ...config.plugins?.entries, sibling: { enabled: true, config: { mode: 42 } } },
      },
    };
    await expect(reload(invalidSettings, [])).rejects.toMatchObject({
      details: { phase: "prepare", committed: false },
    });
    expect(runtime.pluginRuntime.registry).toBe(lastGoodRegistry);
    expect(await probe("sibling")).toEqual(sibling);
    const changedSettings: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          "installed-probe": { enabled: true, config: { label: "changed" } },
        },
      },
    };
    const configReceipt = await reload(changedSettings, []);
    expect(configReceipt.runtime.pluginIds).toEqual(["installed-probe"]);
    const configured = await probe("installed-probe");
    expect(configured.instance).not.toBe(current.instance);
    expect(configured.settings).toEqual({ label: "changed" });
    expect(await probe("sibling")).toEqual(sibling);
  });
}

it.each(["empty", "defaulted"] as const)(
  "loads installed package roots and retains a sibling with %s runtime config",
  verifyInstalledPackageRetention,
);
