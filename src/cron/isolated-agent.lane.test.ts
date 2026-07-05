// Isolated agent lane tests cover lane selection for scheduled agent runs.
import { describe, expect, it } from "vitest";
import { resolveCronAgentLane } from "../agents/lanes.js";
import {
<<<<<<< HEAD
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
=======
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./isolated-agent/run.suite-helpers.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveCronAgentLaneMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function lastEmbeddedLane(): string | undefined {
  const params = runEmbeddedAgentMock.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return (params as { lane?: string }).lane;
}

async function runLaneCase(lane?: string) {
  resolveCronAgentLaneMock.mockImplementation(resolveCronAgentLane);
  mockRunCronFallbackPassthrough();

  await runCronIsolatedAgentTurn(
<<<<<<< HEAD
    makeIsolatedAgentParamsFixture({
      job: makeIsolatedAgentJobFixture({
=======
    makeIsolatedAgentTurnParams({
      job: makeIsolatedAgentTurnJob({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "do it" },
      }),
      message: "do it",
      sessionKey: "cron:job-1",
      ...(lane === undefined ? {} : { lane }),
    }),
  );

  return lastEmbeddedLane();
}

describe("runCronIsolatedAgentTurn lane selection", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("moves the cron lane to cron-nested for embedded runs", async () => {
    expect(await runLaneCase("cron")).toBe("cron-nested");
  });

  it("defaults missing lanes to cron-nested for embedded runs", async () => {
    expect(await runLaneCase()).toBe("cron-nested");
  });

  it("preserves non-cron lanes for embedded runs", async () => {
    expect(await runLaneCase("subagent")).toBe("subagent");
  });
});
