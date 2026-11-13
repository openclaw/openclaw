import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runManagerStartupIdentityReconcile } from "../acp/control-plane/manager.startup-identity-reconcile.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-method-policy.js";
import type { GatewayStartupModuleMocks } from "./server-startup-module-mocks.test-support.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";
import type { postAttachMocks } from "./server-startup-post-attach.mocks.test-support.js";
import { logGatewayReady } from "./server-startup-readiness.js";
import type { startGatewaySidecars } from "./server-startup-sidecars.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";
import { createReadinessChecker, type PreparedReadinessChecker } from "./server/readiness.js";
import { createPreparedReadinessFixture } from "./server/readiness.test-support.js";

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
  startSidecars: (
    overrides: Partial<Parameters<typeof startGatewaySidecars>[0]>,
  ) => Promise<number>;
  waitForState: (assertion: () => void) => Promise<unknown>;
  acpMocks: Pick<
    typeof postAttachMocks,
    "getAcpRuntimeBackend" | "reconcilePendingSessionIdentities"
  >;
}): void {
  it.for([false, true])(
    "announces prepared readiness only before close (closing=%s)",
    async (stop, { signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const access = fs.access;
      const heldAccess = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
        if (args[0] === process.execPath) {
          entered.resolve();
          await release.promise;
        }
        return access(...args);
      });
      let closing = false;
      const log = { info: vi.fn() };
      const getReadiness = createReadinessChecker({
        startedAt: Date.now(),
        channelManager: {
          getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
          getAutostartSuppression: () => null,
          isAmbientAutostartSuppressed: () => false,
        },
      });
      const logging = logGatewayReady({ getReadiness, log, isClosing: () => closing });
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, logging, "readiness did not prepare runtime"),
          signal,
        );
        expect(log.info).not.toHaveBeenCalled();
        closing = stop;
        release.resolve();
        await logging;
        expect(log.info.mock.calls).toEqual(stop ? [] : [["gateway ready"]]);
      } finally {
        release.resolve();
        heldAccess.mockRestore();
        await logging;
      }
    },
  );

  it.each([
    { name: "I/O failure", error: new Error("EIO: session scan failed") },
    { name: "parse failure", error: new SyntaxError("invalid session metadata") },
    { name: "successful empty scan", error: null },
  ])("keeps ACP startup non-fatal and reports $name", async ({ error }) => {
    const log = { warn: vi.fn() };
    const cfg = {
      hooks: { internal: { enabled: false } },
      acp: { enabled: true, backend: "acpx" },
    };
    params.acpMocks.getAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: {} });
    params.acpMocks.reconcilePendingSessionIdentities.mockImplementationOnce(() =>
      runManagerStartupIdentityReconcile({
        cfg,
        deps: {
          listAcpSessions: async () => {
            if (error) {
              throw error;
            }
            return [];
          },
        },
        withSessionActor: vi.fn(),
        resolveSession: vi.fn(),
        ensureRuntimeHandle: vi.fn(),
        reconcileRuntimeSessionIdentifiers: vi.fn(),
      }),
    );

    await params.startSidecars({ cfg, log });
    await params.waitForState(() => {
      expect(params.acpMocks.reconcilePendingSessionIdentities).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    if (error) {
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/acp startup identity reconcile .*checked=0 resolved=0 failed=1/),
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

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
        getReadiness: createPreparedReadinessFixture(() => ({
          ready: false,
          coreReady: false,
          failing: ["agent-database:main"],
          uptimeMs: 0,
        })),
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
      ["postReadySidecarCount", 4],
    ]);
  });
}

export async function expectCoreAgentDatabaseReadiness(
  getReadiness: PreparedReadinessChecker,
  state: OpenClawTestState,
): Promise<void> {
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
      await logGatewayReady({ getReadiness, log });
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
