import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import {
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
} from "../infra/restart.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  isGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";

// Registered server.close, routed by vitest.gateway-server.config.ts to gateway-server.
it.each(["final", "sibling", "cache", "restart", "memory-and-plugin", "memory-only"] as const)(
  "reports plugin cleanup through registered Gateway close (%s)",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`plugin-close-${mode}`);
    fixture.config.agents = {
      defaults: {
        workspace: fixture.state.workspaceDir,
        model: { primary: `${fixture.pluginId}/model` },
      },
    };
    const pluginFailure = new Error("registered plugin cleanup failed");
    const memoryFailure = new Error("registered memory cleanup failed");
    const hasPluginFailure = mode !== "memory-only";
    const hasMemoryFailure = mode === "memory-and-plugin" || mode === "memory-only";
    const port = await fixture.reservePort();
    const logFile = fixture.state.path("shutdown.log");
    setLoggerOverride({ file: logFile, level: "debug", consoleLevel: "silent" });
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: fixture.pluginId });
    const registered = new PluginInstance(record.id, { record, registry });
    if (mode !== "cache" && mode !== "restart") {
      registry.plugins.push(record);
    }
    const memoryDrain = vi.fn(async () => {
      throw memoryFailure;
    });
    if (hasMemoryFailure) {
      registry.memoryCapabilities.push({
        pluginId: record.id,
        capability: registered.wrap({
          runtime: {
            getMemorySearchManager: async () => ({ manager: null }),
            resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
            prepareReload: () => ({ drain: memoryDrain, resume() {} }),
          } satisfies MemoryPluginRuntime,
        }),
      });
    }
    setActivePluginRegistry(registry);
    const sharedEntered = createDeferredCore();
    const releaseShared = createDeferredCore();
    const releaseWork = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const successorStarted = createDeferredCore();
    const successorReady = createDeferredCore();
    const exited = createDeferredCore<number>();
    const completeBoot = vi.fn();
    let exitCode: number | undefined;
    let startCount = 0;
    let restartRequested = false;
    let closing: Promise<unknown> | undefined;
    let activeWork: Promise<void> | undefined;
    let shared: { enabled: boolean } | undefined;
    let sharedSettled = false;
    let closeSettled = false;
    let pluginDisposed = false;
    let pluginSawOpenDatabase = false;
    let stop: ((signal: "SIGINT") => void) | undefined;
    try {
      let server: GatewayServer;
      if (mode === "restart") {
        vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
        for (const name of SUPERVISOR_HINT_ENV_VARS) {
          vi.stubEnv(name, undefined);
        }
        const previousStops = new Set(process.listeners("SIGINT"));
        void runGatewayLoop({
          lockPort: port,
          start: async (options) => {
            startCount += 1;
            if (startCount > 1) {
              successorStarted.resolve();
            }
            const next = await fixture.start(port, {
              hostLifecycle: options?.hostLifecycle,
              startupOperation: options?.startupOperation,
            });
            started.resolve(next);
            if (startCount > 1) {
              successorReady.resolve();
            }
            return next;
          },
          runtime: {
            log() {},
            error() {},
            exit(code) {
              exitCode = code;
              exited.resolve(code);
            },
          },
          completeBoot,
        }).catch(started.reject);
        server = await started.promise;
        stop = process.listeners("SIGINT").find((listener) => !previousStops.has(listener));
        assert(stop);
        await nextTurn();
      } else {
        server = await fixture.start(port);
      }
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      expect(kernel.pluginRuntime.registry).toBe(registry);
      const metadata = kernel.getPluginMetadataSnapshot();
      assert(metadata);
      const instance =
        mode === "cache" || mode === "restart"
          ? getPluginValueInstance(fixture.loadCallback(metadata))
          : registered;
      assert(instance);
      const database = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      expect(database.isOpen).toBe(true);
      expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
      if (hasPluginFailure) {
        instance.lifecycle.onDispose(() => {
          pluginDisposed = true;
          pluginSawOpenDatabase = database.isOpen;
          throw pluginFailure;
        });
      }
      shared = resolveGlobalSingleton(
        Symbol(`plugin-close-shared-${mode}`),
        () => ({ enabled: true }),
        async (state) => {
          if (state.enabled) {
            sharedEntered.resolve();
            await releaseShared.promise;
            sharedSettled = true;
          }
        },
      );
      let siblingPort: number | undefined;
      if (mode === "sibling") {
        setActivePluginRegistry(createEmptyPluginRegistry());
        siblingPort = await fixture.reservePort();
        await fixture.start(siblingPort);
      }
      const close = vi.spyOn(server, "close");
      if (mode === "restart") {
        activeWork = runWithGatewayIndependentRootWorkAdmission(
          () => releaseWork.promise,
          "plugin-close-regression",
        );
        const restart = requestGatewayRestartWithSignalAdmission("plugin-close-regression");
        restartRequested = restart.status === "emitted";
        expect(restart.status).toBe("emitted");
        await expect.poll(isGatewayRestartDraining).toBe(true);
        await nextTurn();
        expect(close).not.toHaveBeenCalled();
        expect(pluginDisposed).toBe(false);
        releaseWork.resolve();
        await activeWork;
        await expect.poll(() => close.mock.calls.length).toBe(1);
        expect(close.mock.calls[0]?.[0]).toMatchObject({
          reason: "gateway restarting",
          restartExpectedMs: 1500,
        });
        closing = close.mock.results[0]?.value;
        assert(closing);
      } else {
        closing = server.close({ reason: "plugin cleanup regression" });
      }
      const outcome = closing
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          closeSettled = true;
        });
      if (mode !== "sibling") {
        await Promise.race([
          sharedEntered.promise,
          outcome.then(() => {
            throw new Error("Close settled before shared cleanup");
          }),
        ]);
        await nextTurn();
        expect(closeSettled).toBe(false);
        expect(sharedSettled).toBe(false);
        expect(pluginDisposed).toBe(hasPluginFailure);
        releaseShared.resolve();
      }
      const error = await outcome;
      if (hasPluginFailure) {
        expect.soft(collectNestedErrorCandidates(error)).toContain(pluginFailure);
        expect(pluginSawOpenDatabase).toBe(true);
      } else {
        expect(error).toBeUndefined();
      }
      if (mode === "restart") {
        await Promise.race([exited.promise, successorStarted.promise]);
        expect.soft(exitCode).toBe(1);
        expect.soft(completeBoot).toHaveBeenCalledWith({
          outcome: "forced_stop",
          reason: "gateway.restart_close_failed",
        });
        expect.soft(startCount).toBe(1);
      }
      await flushLogger();
      const logs = await fs.readFile(logFile, "utf8");
      if (hasPluginFailure) {
        expect(logs).toMatch(new RegExp(`shutdown failed .*plugin/${fixture.pluginId}`));
        expect(logs).not.toContain("shutdown completed cleanly");
      }
      if (hasMemoryFailure) {
        expect(memoryDrain).toHaveBeenCalledOnce();
        expect(logs).toContain(`memory-managers: ${memoryFailure.message}`);
      }
      expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(
        true,
      );
      if (siblingPort !== undefined) {
        expect(sharedSettled).toBe(false);
        expect(database.isOpen).toBe(true);
        expect(getGatewayPluginMetadataSnapshot()).toBeDefined();
        const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
        await response.text();
        expect(response.ok).toBe(true);
      } else {
        expect(sharedSettled).toBe(true);
        expect(database.isOpen).toBe(false);
        expect(getActiveSecretsRuntimeSnapshotState()).toBeNull();
      }
    } finally {
      releaseWork.resolve();
      releaseShared.resolve();
      if (shared) {
        shared.enabled = false;
      }
      await Promise.allSettled([closing, activeWork]);
      if (mode === "restart" && exitCode === undefined && stop) {
        if (restartRequested) {
          await Promise.race([exited.promise, successorReady.promise]);
        }
        if (exitCode === undefined) {
          await nextTurn();
          stop("SIGINT");
          await exited.promise;
        }
      }
      await fixture.cleanup();
      setLoggerOverride(null);
      resetGatewayRestartStateForInProcessRestart();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);
