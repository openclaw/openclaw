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
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";

it.each(["restart", "memory-and-plugin", "session-store"] as const)(
  "reports plugin cleanup through registered Gateway close (%s)",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`plugin-close-${mode}`);
    fixture.config.agents!.defaults!.model = { primary: `${fixture.pluginId}/model` };
    const pluginFailure = new Error("registered plugin cleanup failed");
    const memoryFailure = new Error("registered memory cleanup failed");
    const stateFailure = mode === "session-store";
    const hasPluginFailure = !stateFailure;
    const hasMemoryFailure = mode === "memory-and-plugin";
    const port = await fixture.reservePort();
    const logFile = fixture.state.path("shutdown.log");
    setLoggerOverride({ file: logFile, level: "debug", consoleLevel: "silent" });
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: fixture.pluginId });
    const registered = new PluginInstance(record.id, { record, registry });
    if (mode !== "restart") {
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
    const releaseWork = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const completeBoot = vi.fn();
    let exitCode: number | undefined;
    let running: Promise<number> | undefined;
    let startCount = 0;
    let closing: Promise<unknown> | undefined;
    let activeWork: Promise<void> | undefined;
    let pluginDisposed = false;
    let pluginSawOpenDatabase = false;
    let stop: ((signal: "SIGINT") => void) | undefined;
    try {
      let server: GatewayServer;
      if (mode === "restart") {
        vi.stubEnv("OPENCLAW_NO_RESPAWN", undefined);
        for (const name of SUPERVISOR_HINT_ENV_VARS) {
          vi.stubEnv(name, undefined);
        }
        vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
        const previousStops = new Set(process.listeners("SIGINT"));
        running = runGatewayLoop({
          lockPort: port,
          start: async (options) => {
            startCount += 1;
            const next = await fixture.start(port, {
              hostLifecycle: options?.hostLifecycle,
              startupOperation: options?.startupOperation,
            });
            started.resolve(next);
            return next;
          },
          completeBoot,
        });
        void running
          .then((code) => {
            exitCode = code;
          })
          .catch(started.reject);
        server = await started.promise;
        stop = process.listeners("SIGINT").find((listener) => !previousStops.has(listener));
        assert(stop);
        await nextTurn();
      } else {
        server = await fixture.start(port);
      }
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      if (stateFailure) {
        const closeRegistry = kernel.pluginRuntime.close;
        vi.spyOn(kernel.pluginRuntime, "close").mockImplementation(async (...args) => ({
          ...(await closeRegistry(...args)),
          pluginFailures: [
            { pluginId: fixture.pluginId, hookId: "session-store", error: pluginFailure },
          ],
        }));
      }
      const metadata = kernel.getPluginMetadataSnapshot();
      assert(metadata);
      const instance =
        mode === "restart" ? getPluginValueInstance(fixture.loadCallback(metadata)) : registered;
      assert(instance);
      const database = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      if (hasPluginFailure) {
        instance.lifecycle.onDispose(() => {
          pluginDisposed = true;
          pluginSawOpenDatabase = database.isOpen;
          throw pluginFailure;
        });
      }
      const close = vi.spyOn(server, "close");
      if (mode === "restart") {
        activeWork = runWithGatewayIndependentRootWorkAdmission(
          () => releaseWork.promise,
          "plugin-close-regression",
        );
        const restart = requestGatewayRestartWithSignalAdmission("plugin-close-regression");
        expect(restart.status).toBe("emitted");
        await expect.poll(isGatewayRestartDraining).toBe(true);
        await nextTurn();
        expect(close).not.toHaveBeenCalled();
        expect(pluginDisposed).toBe(false);
        releaseWork.resolve();
        await activeWork;
        await expect.poll(() => close.mock.calls.length).toBe(1);
        closing = close.mock.results[0]?.value;
        assert(closing);
      } else {
        closing = server.close({ reason: "plugin cleanup regression" });
      }
      const error = await closing.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(pluginDisposed).toBe(hasPluginFailure);
      if (stateFailure) {
        expect(collectNestedErrorCandidates(error)).toContain(pluginFailure);
      } else {
        expect(error).toBeUndefined();
      }
      if (hasPluginFailure) {
        expect(pluginSawOpenDatabase).toBe(true);
      }
      if (mode === "restart") {
        await running;
        expect(exitCode).toBe(0);
        expect(completeBoot).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "forced_stop" }),
        );
        expect.soft(startCount).toBe(1);
      }
      await flushLogger();
      const logs = await fs.readFile(logFile, "utf8");
      const cleanupFailure = (hook: string) =>
        `Plugin ${fixture.pluginId} cleanup failed (${hook}): ${pluginFailure.message}`;
      if (stateFailure) {
        expect(logs).toContain(cleanupFailure("session-store"));
        expect(logs).toMatch(/shutdown failed/);
      }
      if (hasPluginFailure) {
        expect(logs).toMatch(
          new RegExp(`shutdown completed .*with warnings:.*plugin/${fixture.pluginId}`),
        );
        expect(logs).toContain(cleanupFailure("instance"));
      }
      if (hasMemoryFailure) {
        expect(logs).toContain(`memory-managers: ${memoryFailure.message}`);
      }
      expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(
        true,
      );
      expect(database.isOpen).toBe(false);
    } finally {
      releaseWork.resolve();
      await Promise.allSettled([closing, activeWork]);
      if (mode === "restart" && exitCode === undefined && stop) {
        await nextTurn();
        stop("SIGINT");
      }
      await Promise.allSettled([running]);
      await fixture.cleanup();
      setLoggerOverride(null);
      resetGatewayRestartStateForInProcessRestart();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);
