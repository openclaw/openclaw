// Runtime plugin tests cover plugin availability during isolated cron runs.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  ensureRuntimePluginsLoadedMock,
  resolveConfiguredModelRefMock,
  resolveCronDeliveryPlanMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn runtime plugins loading", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("loads runtime plugins eagerly using the lazily loaded module", async () => {
    const params = makeIsolatedAgentParamsFixture();

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("ok");
    expect(ensureRuntimePluginsLoadedMock).toHaveBeenCalledOnce();
    expect(ensureRuntimePluginsLoadedMock).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.any(Object),
        }),
      }),
      workspaceDir: "/tmp/workspace", // matches resolveAgentWorkspaceDir mock
      allowGatewaySubagentBinding: true,
    });
    expect(ensureRuntimePluginsLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveConfiguredModelRefMock.mock.invocationCallOrder[0],
    );
    expect(ensureRuntimePluginsLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveCronDeliveryPlanMock.mock.invocationCallOrder[0],
    );
  });

  it("reports runtime plugin load progress through cron execution phases", async () => {
    const phases: unknown[] = [];
    ensureRuntimePluginsLoadedMock.mockImplementation((options: Record<string, unknown>) => {
      const onLoadProgress = options.onLoadProgress;
      if (typeof onLoadProgress === "function") {
        onLoadProgress({
          pluginIds: ["telegram", "memory-core"],
          completedPluginIds: ["telegram"],
          inFlightPluginId: "memory-core",
          inFlightPhase: "register",
        });
      }
    });

    const result = await runCronIsolatedAgentTurn({
      ...makeIsolatedAgentTurnParams(),
      onExecutionPhase: (info) => {
        phases.push(info);
      },
    });

    expect(result.status).toBe("ok");
    expect(phases).toContainEqual(
      expect.objectContaining({
        phase: "runtime_plugins",
        runtimePlugins: {
          pluginIds: ["telegram", "memory-core"],
          completedPluginIds: ["telegram"],
          inFlightPluginId: "memory-core",
          inFlightPhase: "register",
        },
      }),
    );
  });
});
