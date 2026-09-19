import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
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
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

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

async function verifyInstalledPackageRetention(
  settings: "empty" | "defaulted",
  cleanupRetry?:
    | "gateway-stop"
    | "pending-disposal"
    | "candidate-disposal"
    | "recovery-disposal"
    | "mixed-recovery"
    | "active-call",
) {
  const bootstrap = await import("./server-plugin-bootstrap.js");
  const root = makeTrackedTempDir("openclaw-gateway-plugin-ledger-reload", tempDirs);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const resourcePath = path.join(root, "exclusive-resource.lock");
  const stopFailurePath = path.join(root, "refuse-stop");
  const registrations: string[] = [];
  const registrationEvent = `installed-retry-registration:${root}`;
  const observeRegistration = (instance: string) => registrations.push(instance);
  if (cleanupRetry) {
    process.on(registrationEvent, observeRegistration);
    cleanups.push(async () => {
      process.off(registrationEvent, observeRegistration);
    });
  }
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
  ${
    cleanupRetry && id === "installed-probe"
      ? `const fs = require('node:fs');
  process.emit(${JSON.stringify(registrationEvent)}, instance);
  const resource = fs.openSync(${JSON.stringify(resourcePath)}, 'wx');
  api.lifecycle.onDispose(() => {
    fs.closeSync(resource);
    fs.unlinkSync(${JSON.stringify(resourcePath)});
  });
  api.on('gateway_stop', () => {
    if (fs.existsSync(${JSON.stringify(stopFailurePath)})) {
      throw new Error('previous stop hook refused cleanup');
    }
  });`
      : ""
  }
  api.registerService({ id: ${JSON.stringify(id)}, start() {
    if (api.pluginConfig?.failStart) throw new Error("synthetic candidate start failed");
    starts++;
  }, stop() {
    stops++;
  } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops, settings: api.pluginConfig });
  });
} };`,
    );
    return packageDir;
  };
  await withEnvAsync(env, async () => {
    const siblingDir = writePackage("sibling");
    const healthyDir = cleanupRetry === "mixed-recovery" ? writePackage("healthy") : undefined;
    const initialConfig: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      plugins: {
        allow: healthyDir ? ["sibling", "healthy"] : ["sibling"],
        entries: {
          sibling: { enabled: true },
          ...(healthyDir ? { healthy: { enabled: true } } : {}),
        },
        load: { paths: healthyDir ? [siblingDir, healthyDir] : [siblingDir] },
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
    let beforeAttachment: ((candidate: (typeof loaded)[number]) => void) | undefined;
    cleanups.push(async () => {
      try {
        await currentServices?.stop({
          strict: true,
          deadlineAtMs: Date.now() + 5_000,
        });
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
      runtimeState: { cronState: {}, gatewayLifetimeSidecars: createGatewaySidecarStopOwner() },
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
        allow: [...(initialConfig.plugins?.allow ?? []), "installed-probe"],
        entries: { ...initialConfig.plugins?.entries, "installed-probe": { enabled: true } },
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
            beforeAttachment?.(candidate);
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
          prepareConfigEffects: () => async () => {},
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
    if (cleanupRetry === "mixed-recovery") {
      assert.ok(healthyDir);
      const healthy = await probe("healthy");
      const healthyRecord = runtime.pluginRuntime.registry.plugins.find(
        (record) => record.id === "healthy",
      );
      fs.writeFileSync(stopFailurePath, "fail once");
      try {
        await expect(reload()).rejects.toMatchObject({ details: { phase: "drain" } });
      } finally {
        fs.rmSync(stopFailurePath, { force: true });
      }
      expect(registrations).toEqual([first.instance]);
      expect(fs.existsSync(resourcePath)).toBe(false);
      expect(await probe("healthy")).toEqual(healthy);
      const healthyHelper = path.join(healthyDir, "dist", "helper.cjs");
      fs.writeFileSync(healthyHelper, 'module.exports = "candidate-D";');
      beforeAttachment = () => {
        // D's candidate loaded the new bytes. Its recovery must use captured old
        // code even when the original dependency becomes unreadable before start.
        fs.writeFileSync(healthyHelper, "module.exports = ;");
        beforeAttachment = undefined;
      };
      const mixedConfig: OpenClawConfig = {
        ...config,
        plugins: {
          ...config.plugins,
          entries: {
            ...config.plugins?.entries,
            "installed-probe": { enabled: true, config: { failStart: true } },
            healthy: { enabled: true, config: { candidate: true } },
          },
        },
      };
      await expect(reload(mixedConfig, ["installed-probe", "healthy"])).rejects.toMatchObject({
        details: { phase: "activate", committed: false },
      });
      const recoveredHealthy = await probe("healthy");
      expect(recoveredHealthy).toEqual({ ...healthy, instance: expect.any(String) });
      expect(recoveredHealthy.instance).not.toBe(healthy.instance);
      expect(
        runtime.pluginRuntime.registry.plugins.find((record) => record.id === "healthy"),
      ).not.toBe(healthyRecord);
      expect(
        runtime.pluginRuntime.registry.gatewayHandlers["installed-probe.probe"],
      ).toBeUndefined();
      expect(owner.getReloadStatus()).toMatchObject({
        phase: "failed",
        pluginIds: ["installed-probe"],
      });
      expect(registrations).toHaveLength(2);
      expect(fs.existsSync(resourcePath)).toBe(false);
      expect(runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling")).toBe(
        siblingRecord,
      );
      expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(siblingHandler);
      expect(await probe("sibling")).toEqual(sibling);
      return;
    }
    if (cleanupRetry) {
      const retiredRegistry = runtime.pluginRuntime.registry;
      const retiredRecord = retiredRegistry.plugins.find(
        (record) => record.id === "installed-probe",
      );
      assert.ok(retiredRecord);
      const retiredInstance = getPluginInstance(retiredRecord);
      assert.ok(retiredInstance);
      if (cleanupRetry === "active-call") {
        const release = createDeferredCore();
        const effectsPath = path.join(root, "completed-call.txt");
        const call = retiredInstance.run(async () => {
          await release.promise;
          fs.writeFileSync(effectsPath, "completed once");
        });
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        let failedSettled = false;
        const failed = reload().catch((error: unknown) => {
          failedSettled = true;
          return error;
        });
        try {
          await vi.waitFor(() => expect(retiredInstance.acceptingCalls).toBe(false));
          await vi.advanceTimersByTimeAsync(5_000);
          expect(failedSettled).toBe(false);
          expect(owner.getReloadStatus()).toMatchObject({
            phase: "reloading",
            deadlineAtMs: expect.any(Number),
            reason: expect.stringContaining("admitted work"),
          });
          expect(retiredInstance.disposing).toBe(false);
          expect(retiredInstance.lifecycle.signal.aborted).toBe(false);
          expect(fs.existsSync(resourcePath)).toBe(true);
          expect(registrations).toEqual([first.instance]);
          const deadlineAtMs = owner.getReloadStatus()?.deadlineAtMs;
          assert.ok(deadlineAtMs);
          await vi.advanceTimersByTimeAsync(deadlineAtMs - Date.now());
          expect(await failed).toMatchObject({
            details: { phase: "drain", committed: false, pluginIds: ["installed-probe"] },
            message: expect.stringMatching(
              /plugin installed-probe admitted work.*previous plugin generation stays active/,
            ),
          });
          expect(owner.getReloadStatus()).toBeUndefined();
          expect(retiredInstance.acceptingCalls).toBe(true);
          expect(retiredInstance.disposing).toBe(false);
          expect(retiredInstance.lifecycle.signal.aborted).toBe(false);
          expect(runtime.pluginRuntime.registry).toBe(retiredRegistry);
          expect(registrations).toEqual([first.instance]);
          expect(fs.existsSync(resourcePath)).toBe(true);
          expect(fs.existsSync(effectsPath)).toBe(false);
          expect(retiredInstance.run(() => "still serving")).toBe("still serving");
          expect(await probe("installed-probe")).toEqual(first);
          expect(await probe("sibling")).toEqual(sibling);

          // The original write retains its resources after the replacement times out.
          release.resolve();
          await call;
          expect(fs.readFileSync(effectsPath, "utf8")).toBe("completed once");
          expect(retiredInstance.run(() => "still serving")).toBe("still serving");
          fs.writeFileSync(
            path.join(packageDir, "dist", "helper.cjs"),
            'module.exports = "retry";',
          );
          await expect(reload()).resolves.toMatchObject({
            runtime: { pluginIds: ["installed-probe"] },
          });
          expect(owner.getReloadStatus()).toBeUndefined();
          const current = await probe("installed-probe");
          expect(current.helper).toBe("retry");
          expect(current.instance).not.toBe(first.instance);
          expect(registrations).toEqual([first.instance, current.instance]);
          expect(retiredInstance.disposing).toBe(true);
          expect(fs.readFileSync(effectsPath, "utf8")).toBe("completed once");
          expect(
            runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling"),
          ).toBe(siblingRecord);
          expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(
            siblingHandler,
          );
          expect(await probe("sibling")).toEqual(sibling);
        } finally {
          release.resolve();
          try {
            await call;
            await vi.advanceTimersByTimeAsync(5_000);
            await failed;
          } finally {
            vi.useRealTimers();
          }
        }
        return;
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let blockedInstance = retiredInstance;
      const gateDisposal = () => {
        // Physical source cleanup remains owned after the caller's observation budget expires.
        blockedInstance.onModuleDispose(async () => {
          entered.resolve();
          await release.promise;
        });
      };
      let rejectedConfig = config;
      const rejectedRuntime =
        cleanupRetry === "candidate-disposal" || cleanupRetry === "recovery-disposal";
      if (cleanupRetry === "pending-disposal") {
        gateDisposal();
      } else if (cleanupRetry === "gateway-stop") {
        fs.writeFileSync(stopFailurePath, "fail once");
      } else {
        rejectedConfig = {
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins?.entries,
              "installed-probe": { enabled: true, config: { failStart: true } },
            },
          },
        };
        let attachments = 0;
        beforeAttachment = (candidate) => {
          attachments++;
          if (attachments !== (cleanupRetry === "candidate-disposal" ? 1 : 2)) {
            return;
          }
          const record = candidate.pluginRegistry.plugins.find(
            (entry) => entry.id === "installed-probe",
          );
          assert.ok(record);
          const instance = getPluginInstance(record);
          assert.ok(instance);
          blockedInstance = instance;
          gateDisposal();
          if (cleanupRetry === "recovery-disposal") {
            throw new Error("synthetic recovery attachment failed");
          }
        };
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const failed = reload(rejectedConfig).catch((error: unknown) => error);
      let retry: Promise<Awaited<ReturnType<typeof reload>>> | undefined;
      try {
        if (cleanupRetry !== "gateway-stop") {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(rejectedRuntime ? 10_000 : 5_000);
        }
        expect(await failed).toMatchObject({
          details: {
            phase: rejectedRuntime ? "activate" : "drain",
            committed: false,
            pluginIds: ["installed-probe"],
          },
        });
        expect(runtime.pluginRuntime.registry).toBe(retiredRegistry);
        expect(registrations).toHaveLength(
          cleanupRetry === "candidate-disposal" ? 2 : cleanupRetry === "recovery-disposal" ? 3 : 1,
        );
        const failedRegistrations = [...registrations];
        expect(() => retiredInstance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
        expect(await probe("sibling")).toEqual(sibling);

        fs.rmSync(stopFailurePath, { force: true });
        fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "retry";');
        if (cleanupRetry !== "gateway-stop") {
          expect(fs.existsSync(resourcePath)).toBe(true);
          retry = reload();
          const pendingOutcome = retry.then(
            () => ({ accepted: true as const }),
            (error: unknown) => ({ accepted: false as const, error }),
          );
          await nextTurn();
          expect(registrations).toEqual(failedRegistrations);
          expect(fs.existsSync(resourcePath)).toBe(true);
          release.resolve();
          await blockedInstance.dispose();
          // Admission may wait or reject while cleanup is pending. A subsequent
          // retry after settlement must work without a Gateway restart either way.
          const outcome = await pendingOutcome;
          if (!outcome.accepted) {
            expect(outcome.error).toMatchObject({ details: { committed: false } });
            retry = reload();
          }
        } else {
          expect(fs.existsSync(resourcePath)).toBe(false);
          retry = reload();
        }
        await expect(retry).resolves.toMatchObject({ runtime: { pluginIds: ["installed-probe"] } });
        const current = await probe("installed-probe");
        expect(current.helper).toBe("retry");
        expect(current.instance).not.toBe(first.instance);
        expect(registrations).toEqual([...failedRegistrations, current.instance]);
        expect(fs.existsSync(resourcePath)).toBe(true);
        expect(
          runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling"),
        ).toBe(siblingRecord);
        expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(
          siblingHandler,
        );
        expect(await probe("sibling")).toEqual(sibling);
      } finally {
        fs.rmSync(stopFailurePath, { force: true });
        release.resolve();
        await Promise.allSettled([
          failed,
          retry,
          retiredInstance.dispose(),
          blockedInstance.dispose(),
        ]);
        vi.useRealTimers();
      }
      return;
    }
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
      details: { phase: "activate", committed: false, pluginIds: ["installed-probe"] },
    });
    expect(runtime.pluginRuntime.registry).not.toBe(lastGoodRegistry);
    const syntaxRecovery = await probe("installed-probe");
    expect(syntaxRecovery).toEqual({ ...current, instance: expect.any(String) });
    expect(syntaxRecovery.instance).not.toBe(current.instance);
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
    const activationRecoveryRegistry = runtime.pluginRuntime.registry;
    expect(activationRecoveryRegistry).not.toBe(lastGoodRegistry);
    const activationRecovery = await probe("installed-probe");
    expect(activationRecovery).toEqual({ ...current, instance: expect.any(String) });
    expect(activationRecovery.instance).not.toBe(syntaxRecovery.instance);
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
    expect(runtime.pluginRuntime.registry).toBe(activationRecoveryRegistry);
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
  (settings) => verifyInstalledPackageRetention(settings),
);

it.each(["gateway-stop", "pending-disposal", "candidate-disposal", "recovery-disposal"] as const)(
  "retries a real installed plugin after %s cleanup failure without restarting its sibling",
  (cleanupRetry) => verifyInstalledPackageRetention("empty", cleanupRetry),
);

it("recovers a healthy changed plugin from captured code while excluding a previously retired plugin", () =>
  verifyInstalledPackageRetention("empty", "mixed-recovery"));

it("retries after an admitted call outlasts the replacement deadline without restarting its sibling", () =>
  verifyInstalledPackageRetention("empty", "active-call"));
