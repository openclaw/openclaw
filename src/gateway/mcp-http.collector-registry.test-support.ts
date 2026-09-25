import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "../agents/tools/structured-output-tool.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

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
  entry: Pick<Parameters<typeof addSubagentRunForTests>[0], "runId" | "outputSchema"> & {
    childSessionKey: string;
  },
) {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "mcp-collector" });
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main" },
      { sessionId: "mcp-collector-parent", updatedAt: 1 },
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey: entry.childSessionKey },
      {
        sessionId: entry.runId,
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        completionOwnerSessionKey: "agent:main:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
      },
    );
  });
  afterAll(async () => {
    await state.cleanup();
  });
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
