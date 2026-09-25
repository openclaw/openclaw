import { expect, it, vi } from "vitest";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";
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
      ["postReadySidecarCount", 4],
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
