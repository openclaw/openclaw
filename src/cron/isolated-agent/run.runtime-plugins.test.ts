import { describe, expect, it } from "vitest";
import { makeIsolatedAgentTurnParams, setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  ensureRuntimePluginsLoadedMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn runtime plugins loading", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("loads runtime plugins eagerly using the lazily loaded module", async () => {
    const params = makeIsolatedAgentTurnParams();

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
    });
  });
});
