import { afterEach, beforeEach, vi } from "vitest";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "../agents/tools/structured-output-tool.js";

vi.mock("../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../agents/subagents/registry/subagent-registry-state.js")
    >();
  return {
    ...actual,
    persistSubagentRunsToDiskOrThrow: vi.fn(actual.persistSubagentRunsToDiskOrThrow),
  };
});

export function useMcpCollectorRegistry(
  entry: Pick<
    Parameters<typeof addSubagentRunForTests>[0],
    "runId" | "childSessionKey" | "outputSchema"
  >,
) {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    vi.mocked(persistSubagentRunsToDiskOrThrow).mockImplementation(() => {});
    addSubagentRunForTests({ ...entry, collect: true });
  });
  afterEach(() => {
    consumeSwarmStructuredOutput(entry.runId);
    resetSubagentRegistryForTests({ persist: false });
    vi.mocked(persistSubagentRunsToDiskOrThrow).mockReset();
  });
}
