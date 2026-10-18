import { performance } from "node:perf_hooks";
import { expect, it, vi, type Mock } from "vitest";
import type { AcpStartupIdentityReconcileResult } from "../acp/control-plane/manager.types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  startGatewayPostAttachRuntime,
  startGatewaySidecars,
} from "./server-startup-post-attach.js";
import { logGatewayReady } from "./server-startup-readiness.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { ReadinessChecker } from "./server/readiness.js";

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];

export function registerGatewayStartupReadinessTests(params: {
  start: typeof startGatewayPostAttachRuntime;
  createParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
}): void {
  it.each([false, true])(
    "does not announce readiness while a core agent is refused (canary=%s)",
    async (updateCanary) => {
      const startup = params.createParams({
        updateCanary,
        getReadiness: () => ({
          ready: false,
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

export function registerGatewayStartupAcpReadinessTests(params: {
  startSidecars: (
    overrides?: Partial<Parameters<typeof startGatewaySidecars>[0]>,
  ) => Promise<number>;
  createTrace: () => {
    startupTrace: GatewayStartupTrace;
    measures: string[];
    details: Array<{
      name: string;
      metrics: ReadonlyArray<readonly [string, number | string]>;
    }>;
  };
  waitForState: (assertion: () => void) => Promise<unknown>;
  getAcpRuntimeBackend: Mock<(id?: string) => unknown>;
  reconcilePendingSessionIdentities: Mock<() => Promise<AcpStartupIdentityReconcileResult>>;
}): void {
  it.each([
    { failed: 1, warns: true },
    { failed: 0, warns: false },
  ])(
    "reports ACP startup scans with no checked sessions and failed=$failed",
    async ({ failed, warns }) => {
      const log = { warn: vi.fn() };
      params.getAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime: {} });
      params.reconcilePendingSessionIdentities.mockResolvedValueOnce({
        checked: 0,
        resolved: 0,
        failed,
      });

      await params.startSidecars({
        cfg: {
          hooks: { internal: { enabled: false } },
          acp: { enabled: true, backend: "acpx" },
        },
        log,
      });
      await params.waitForState(() => {
        expect(params.reconcilePendingSessionIdentities).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });

      if (warns) {
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(/acp startup identity reconcile .*checked=0 resolved=0 failed=1/),
        );
      } else {
        expect(log.warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { direction: "forward", shiftedWallClockMs: 10_000, monotonicMs: 50, timedOut: false },
    { direction: "backward", shiftedWallClockMs: -10_000, monotonicMs: 5_000, timedOut: true },
  ])(
    "waits for a healthy ACP runtime backend before startup identity reconcile after a $direction wall-clock shift",
    async ({ shiftedWallClockMs, monotonicMs, timedOut }) => {
      const trace = params.createTrace();
      let healthy = false;
      let wallClockMs = 10_000;
      const wallClockNow = vi.spyOn(Date, "now").mockImplementation(() => wallClockMs);
      const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
      const probeHealth = vi.fn(() => healthy);
      params.getAcpRuntimeBackend.mockImplementation((id?: string) => ({
        id: id ?? "acpx",
        runtime: {},
        healthy: probeHealth,
      }));

      try {
        await params.startSidecars({
          cfg: {
            hooks: { internal: { enabled: false } },
            acp: { enabled: true, backend: "acpx" },
          } as never,
          startupTrace: trace.startupTrace,
        });

        await params.waitForState(() => {
          expect(params.getAcpRuntimeBackend).toHaveBeenCalledWith("acpx");
        });
        expect(params.reconcilePendingSessionIdentities).not.toHaveBeenCalled();

        wallClockMs += shiftedWallClockMs;
        monotonicNow.mockReturnValue(monotonicMs);
        if (!timedOut) {
          await params.waitForState(() => {
            expect(probeHealth.mock.calls.length).toBeGreaterThan(1);
          });
          expect(params.reconcilePendingSessionIdentities).not.toHaveBeenCalled();
          healthy = true;
        }
        await params.waitForState(() => {
          expect(params.reconcilePendingSessionIdentities).toHaveBeenCalledTimes(1);
        });
        expect(trace.measures).toContain("sidecars.acp.runtime-ready");
        expect(trace.measures).toContain("sidecars.acp.identity-reconcile");
        expect(trace.details).toContainEqual({
          name: "sidecars.acp.runtime-ready",
          metrics: [
            ["readyCount", timedOut ? 0 : 1],
            ["backend", "acpx"],
          ],
        });
      } finally {
        healthy = true;
        wallClockNow.mockRestore();
        monotonicNow.mockRestore();
        await params.waitForState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
    },
  );
}
