import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { configureMockSubagentRegistryPersistence } from "../agents/subagent-test-fixtures.test-helpers.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "../agents/tools/structured-output-tool.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

export function useMcpCollectorRegistry(
  entry: Pick<
    Parameters<typeof addSubagentRunForTests>[0],
    "runId" | "childSessionKey" | "outputSchema"
  >,
) {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-mcp-collector-registry-",
      layout: "state-only",
    });
  });
  beforeEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    await configureMockSubagentRegistryPersistence({ persistRegistryRows: () => {} });
    await addSubagentRunForTests({ ...entry, collect: true });
  });
  afterEach(async () => {
    consumeSwarmStructuredOutput(entry.runId);
    await resetSubagentRegistryForTests();
  });
  afterAll(async () => {
    await state.cleanup();
  });
}
