import { afterEach, expect, it, vi } from "vitest";
import * as processes from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import * as display from "./session-utils-display.js";

afterEach(() => vi.restoreAllMocks());

it("reads process state once and refreshes origin run ids and counts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const keys = ["agent:main:process-a", "agent:main:process-b"];
    keys.forEach((key, index) => seedRow(key, { sessionId: `process-${index}`, updatedAt: 1 }));
    const process = createProcessSessionFixture({ id: "running", backgrounded: true });
    process.scopeKey = "process-0";
    process.agentId = "main";
    process.originRunId = "run-a";
    processes.addSession(process);
    try {
      using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      using reads = vi.spyOn(processes, "listRunningSessions");
      using runStates = vi.spyOn(display, "projectGatewaySessionRunState");
      const read = () => {
        reads.mockClear();
        runStates.mockClear();
        const presenter = prepareSessionRowPublication(projection, Date.now())().getPresentation();
        const rows = keys.map((key) => presenter.snapshot({ key, agentId: "main" }).row);
        expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
        expect(runStates).toHaveBeenCalledTimes(keys.length);
        return rows.map((row) => [row?.backgroundProcessCount, row?.backgroundProcessRunIds]);
      };

      expect(read()).toEqual([
        [1, ["run-a"]],
        [undefined, undefined],
      ]);
      expect(read()).toEqual([
        [1, ["run-a"]],
        [undefined, undefined],
      ]);

      process.originRunId = "run-b";
      expect(read()).toEqual([
        [1, ["run-b"]],
        [undefined, undefined],
      ]);

      processes.markExited(process, 0, null, "completed");
      expect(read()).toEqual([
        [undefined, undefined],
        [undefined, undefined],
      ]);
    } finally {
      resetProcessRegistryForTests();
    }
  });
});
