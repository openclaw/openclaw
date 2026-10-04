import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveConfiguredModelRefMock,
  resolveSessionAuthSelectionMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
setupRunCronIsolatedAgentTurnSuite();

describe("isolated cron auth selection (#62783)", () => {
  it("preserves auth selection despite a fresh isolated session", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openrouter:default",
      source: "auto",
      routeRequirement: "api-key",
    });
    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            profiles: { "openrouter:default": { provider: "openrouter", mode: "api_key" } },
            order: { openrouter: ["openrouter:default"] },
          },
        },
        job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" } }),
      }),
    );
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter", isNewSession: false }),
    );
  });
});
