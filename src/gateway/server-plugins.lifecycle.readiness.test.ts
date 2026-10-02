import fs from "node:fs/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { markGatewayRestartHandled } from "../infra/restart.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  installInstanceBindingProbeCoordinator,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import type { CanonicalGatewayReadinessResult } from "./server/readiness.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// The shared server helper mocks plugin loading; this suite exercises a real fixture plugin.
vi.doUnmock("../plugins/loader.js");

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway readiness plugin lifecycle", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;

  afterEach(async () => {
    markGatewayRestartHandled();
    socket?.close();
    socket = undefined;
    await server?.close({ reason: "readiness plugin lifecycle cleanup" });
    server = undefined;
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    clearPluginMetadataLifecycleCaches();
  });

  it(
    "quarantines pending readiness across config.patch plugin replacement",
    { timeout: 600_000 },
    async () => {
      type Check = PluginReadinessCriterionRegistration["criterion"]["check"];
      type CheckResult = Awaited<ReturnType<Check>>;
      const success: CheckResult = {
        status: "True",
        reason: "RetiredReady",
        message: "Retired backend is ready.",
      };
      const unavailable: CheckResult = {
        status: "False",
        reason: "ReplacementUnavailable",
        message: "Replacement backend is unavailable.",
      };
      const retired = createDeferredCore<CheckResult>();
      onTestFinished(() => retired.resolve(success));
      let retiredSignal: AbortSignal | undefined;
      let active = 0;
      let maxActive = 0;
      const retiredCheck = vi.fn<Check>(async ({ signal }) => {
        retiredSignal = signal;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await retired.promise;
        } finally {
          active -= 1;
        }
      });
      const replacementCheck = vi.fn<Check>(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return unavailable;
        } finally {
          active -= 1;
        }
      });
      const configIo = await import("../config/io.js");
      const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const configWriter = vi
        .spyOn(configIo, "writeConfigFile")
        .mockImplementation(actualIo.writeConfigFile);
      onTestFinished(() => configWriter.mockRestore());
      const coordinator = installInstanceBindingProbeCoordinator();
      coordinator.readinessCheck = retiredCheck;
      const bundledRoot = tempDirs.make("openclaw-readiness-lifecycle-");
      await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName);
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
      }
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          gateway: {
            readiness: { requiredCriteria: ["plugin.instance-binding-probe.backend"] },
          },
          plugins: {
            enabled: true,
            allow: ["instance-binding-probe"],
            entries: { "instance-binding-probe": { enabled: true } },
          },
        })}\n`,
      );
      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      await server.startupSettled;
      const probe = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(10_000),
        });
        return {
          status: response.status,
          body: (await response.json()) as CanonicalGatewayReadinessResult,
        };
      };
      const expectBackend = (
        response: Awaited<ReturnType<typeof probe>>,
        status: "False" | "Unknown",
        reason: string,
      ) => {
        expect(response.status).toBe(503);
        expect(response.body.ready).toBe(false);
        expect(response.body.conditions).toContainEqual(
          expect.objectContaining({
            type: "plugin.instance-binding-probe.backend",
            status,
            reason,
          }),
        );
      };

      const retiredProbe = probe();
      void retiredProbe.catch(() => {});
      await vi.waitFor(() => expect(retiredSignal).toBeDefined(), { timeout: 5_000 });
      expect(active).toBe(1);
      socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      const current = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(current.ok).toBe(true);
      const registrationsBeforeReload = coordinator.runtimes.length;
      coordinator.readinessCheck = replacementCheck;
      const reload = await rpcReq(socket, "config.patch", {
        raw: JSON.stringify({
          plugins: {
            entries: {
              "instance-binding-probe": { subagent: { allowModelOverride: true } },
            },
          },
        }),
        baseHash: current.payload?.hash,
      });
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(registrationsBeforeReload);
      expectBackend(await probe(), "Unknown", "CriterionPreviousEvaluationPending");
      expect(retiredSignal?.aborted).toBe(true);
      expect(replacementCheck).not.toHaveBeenCalled();
      expect(active).toBe(1);
      expect(maxActive).toBe(1);

      retired.resolve(success);
      const retiredResponse = await retiredProbe;
      expect(retiredResponse.status).toBe(503);
      expect(retiredResponse.body.ready).toBe(false);
      const retiredCondition = retiredResponse.body.conditions.find(
        (condition) => condition.type === "plugin.instance-binding-probe.backend",
      );
      expect(retiredCondition).toBeDefined();
      expect(retiredCondition?.status).not.toBe("True");
      expect(retiredCondition?.reason).not.toBe("RetiredReady");
      await expect.poll(() => active).toBe(0);
      expect(maxActive).toBe(1);
      expectBackend(await probe(), "False", "ReplacementUnavailable");
      expect(replacementCheck).toHaveBeenCalledTimes(1);
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    },
  );
});
