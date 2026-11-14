import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();

describe("undecodable scheduled authority", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([undefined, { version: 1 }, { version: 1, snapshot: null }])(
    "refuses preparation before creating an unsandboxed session or running inference: %j",
    async (source) => {
      await expect(
        runAgent(
          makeIsolatedAgentParamsFixture({
            job: makeIsolatedAgentJobFixture({
              operatorSource: { executionRevision: "invalid", source },
            }),
          }),
        ),
      ).rejects.toThrow("Restart recovery operator source");
      expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
      expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
    },
  );
});
