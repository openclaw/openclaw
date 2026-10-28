import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-method-policy.js";
import type { GatewayStartupModuleMocks } from "./server-startup-module-mocks.test-support.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";
import { logGatewayReady } from "./server-startup-readiness.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { ReadinessChecker } from "./server/readiness.js";

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];

export function createStartupMethodUnlocker(unavailableGatewayMethods: Set<string>) {
  return () => {
    for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
      unavailableGatewayMethods.delete(method);
    }
  };
}

export function registerGatewayStartupReadinessTests(params: {
  start: (
    params: PostAttachParams,
    runtimeDeps?: GatewayStartupModuleMocks,
  ) => ReturnType<typeof startGatewayPostAttachRuntime>;
  createParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
  createRuntimeDeps: () => GatewayStartupModuleMocks;
  path: (...parts: string[]) => string;
  expectAutonomousSidecarsNotStarted: () => void;
}): void {
  it.each(["ready", "aborted", "closing", "logging failed"] as const)(
    "releases minimal Gateway account starts only after successful startup: %s",
    async (outcome) => {
      const logging = createDeferred();
      const loggingStarted = createDeferred();
      const controller = new AbortController();
      const startupError = new Error("minimal startup logging failed");
      let closing = false;
      const onChannelsStarted = vi.fn();
      const startupParams = params.createParams({
        minimalTestGateway: true,
        sidecarStartup: "defer",
        isClosing: () => closing,
        trackStartupWork: (run) => run(controller.signal),
        onChannelsStarted,
      });
      const runtime = await params.start(startupParams, {
        ...params.createRuntimeDeps(),
        logGatewayStartup: async () => {
          loggingStarted.resolve();
          await logging.promise;
        },
      });
      try {
        await awaitGateBeforeSettlement(
          loggingStarted.promise,
          runtime.startupSettled,
          "minimal startup settled before logging completed",
        );
        expect(onChannelsStarted).not.toHaveBeenCalled();
        if (outcome === "aborted") {
          controller.abort();
        }
        closing = outcome === "closing";
        if (outcome === "logging failed") {
          logging.reject(startupError);
          await expect(runtime.startupSettled).rejects.toBe(startupError);
        } else {
          logging.resolve();
          await runtime.startupSettled;
        }
        expect(onChannelsStarted).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
        expect(startupParams.startChannels).not.toHaveBeenCalled();
        params.expectAutonomousSidecarsNotStarted();
      } finally {
        logging.resolve();
        await Promise.allSettled([runtime.startupSettled]);
      }
    },
  );

  it.each([true, false])(
    "admits update canary readiness only for attributed plugin failures (attributed=%s)",
    async (attributed) => {
      const error = "synthetic registration failure";
      const diagnostic = {
        level: "error" as const,
        message: error,
        ...(attributed ? { pluginId: "startup-fixture" } : {}),
      };
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.plugins.push(
        createPluginRecord({
          id: "startup-fixture",
          source: params.path("startup-fixture", "index.js"),
          status: "error",
          error,
        }),
      );
      pluginRegistry.diagnostics.push({ ...diagnostic });
      const onStartupPluginsLoaded =
        vi.fn<NonNullable<PostAttachParams["onStartupPluginsLoaded"]>>();
      const onSidecarsReady = vi.fn();
      const startupParams = params.createParams({
        updateCanary: true,
        pluginRegistry: createEmptyPluginRegistry(),
        loadStartupPlugins: async () => ({ pluginRegistry, gatewayMethods: ["ping"] }),
        onStartupPluginsLoaded,
        onSidecarsReady,
      });
      const runtimeDeps = params.createRuntimeDeps();
      const startup = params.start(startupParams, runtimeDeps);
      if (attributed) {
        await startup;
      } else {
        await expect(startup).rejects.toThrow(
          "Candidate plugin registry reported an unattributed error",
        );
      }
      expect(onSidecarsReady).toHaveBeenCalledTimes(Number(attributed));
      expect(startupParams.unlockStartupMethods).toHaveBeenCalledTimes(Number(attributed));
      const published = onStartupPluginsLoaded.mock.lastCall?.[0].pluginRegistry;
      expect(published?.plugins).toMatchObject([
        {
          id: "startup-fixture",
          status: "error",
          activated: true,
          error,
        },
      ]);
      expect(published?.diagnostics).toEqual([diagnostic]);
      expect(startupParams.startChannels).not.toHaveBeenCalled();
      params.expectAutonomousSidecarsNotStarted();
      expect(runtimeDeps.createGatewayUpdateCheck).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "does not announce readiness while a core agent is refused (canary=%s)",
    async (updateCanary) => {
      const startup = params.createParams({
        updateCanary,
        getReadiness: () => ({
          ready: false,
          coreReady: false,
          failing: ["agent-database:main"],
          uptimeMs: 0,
        }),
      });
      const runtime = await params.start(startup);
      await runtime.startupSettled;

      expect(startup.log.info).not.toHaveBeenCalledWith("gateway ready");
      expect(startup.log.info).not.toHaveBeenCalledWith(
        "candidate gateway ready; autonomous sidecars suppressed",
      );
    },
  );

  it("emits a sidecar readiness summary in startup trace details", async () => {
    const trace: GatewayStartupTrace = {
      detail: vi.fn(),
      mark: vi.fn(),
      measure: async (_name, run) => await run(),
    };
    await params.start(params.createParams({ startupTrace: trace }));

    expect(trace.mark).toHaveBeenCalledWith("sidecars.ready");
    expect(trace.detail).toHaveBeenCalledWith("sidecars.ready", [
      ["loadedPluginCount", 2],
      ["postReadySidecarCount", 3],
    ]);
  });
}

export function expectCoreAgentDatabaseReadiness(
  getReadiness: ReadinessChecker,
  state: OpenClawTestState,
): void {
  expect(getReadiness()).toMatchObject({ ready: true, failing: [] });
  try {
    for (const agentId of ["worker", "main", "openclaw", "crestodian"]) {
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId,
        paths: [state.statePath(`agents/${agentId}/openclaw-agent.sqlite`)],
        reason: `Agent ${agentId} requires session identity migration.`,
      });
      recordAgentDatabaseAdmissions([refusal], { source: "startup", env: state.env });
      const log = { info: vi.fn() };
      logGatewayReady({ getReadiness, log });
      expect(log.info).toHaveBeenCalledTimes(agentId === "worker" ? 1 : 0);
      expect(getReadiness()).toMatchObject(
        agentId === "worker"
          ? { ready: true, failing: [] }
          : {
              ready: false,
              failing: [`agent-database:${agentId}`],
              agentDatabases: [refusal],
            },
      );
    }
  } finally {
    recordAgentDatabaseAdmissions([], { source: "startup", env: state.env });
  }
  expect(getReadiness()).toMatchObject({ ready: true, failing: [] });
}
