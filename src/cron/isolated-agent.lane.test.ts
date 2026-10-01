import { describe, expect, it } from "vitest";
import { resolveCronAgentLane } from "../agents/lanes.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveCronAgentLaneMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
setupRunCronIsolatedAgentTurnSuite();

describe("cron lane selection", () => {
  it("moves embedded runs off the scheduler's cron lane", async () => {
    resolveCronAgentLaneMock.mockImplementation(resolveCronAgentLane);
    mockRunCronFallbackPassthrough();
    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" } }),
        lane: "cron",
      }),
    );
    expect(runEmbeddedAgentMock.mock.calls.at(-1)?.[0].lane).toBe("cron-nested");
  });
});
