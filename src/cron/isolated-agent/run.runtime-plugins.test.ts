// Runtime plugin tests cover plugin availability during isolated cron runs.
import { describe, expect, it } from "vitest";
<<<<<<< HEAD
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
=======
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    const params = makeIsolatedAgentParamsFixture();
=======
    const params = makeIsolatedAgentTurnParams();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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
});
