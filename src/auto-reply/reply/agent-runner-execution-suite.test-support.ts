import { vi } from "vitest";
import {
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  getRawExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

export async function setupExecutionSuite() {
  const state = await setupAgentRunnerExecutionTestState();
  const execute = await getExecuteAgentTurnForTest();
  const executeRaw = await getRawExecuteAgentTurnForTest();
  const { emitAgentEvent } = await import("../../infra/agent-events.js");
  const params = (overrides: Partial<AgentTurnParams> = {}) => ({
    ...createMinimalRunAgentTurnParams(overrides),
    ...overrides,
  });
  return {
    state,
    clearEvents: () => vi.mocked(emitAgentEvent).mockClear(),
    runTurn: (overrides?: Partial<AgentTurnParams>) => execute(params(overrides)),
    runRawTurn: (overrides?: Partial<AgentTurnParams>) => executeRaw(params(overrides)),
    terminalEvents: (runId?: string) =>
      vi
        .mocked(emitAgentEvent)
        .mock.calls.map(([event]) => event)
        .filter(
          (event) =>
            (runId === undefined || event.runId === runId) &&
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        ),
  };
}
