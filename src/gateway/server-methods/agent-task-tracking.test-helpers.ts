import path from "node:path";
import { vi } from "vitest";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { getAgentTestMocks } from "./agent.test-harness.js";

export function spyDetachedCreateRunningTaskRun() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const createRunningTaskRunSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
      defaultRuntime.createRunningTaskRun(...args),
  );
  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    createRunningTaskRun: createRunningTaskRunSpy,
  });
  return createRunningTaskRunSpy;
}

// Shared by every spawned-child handler fixture; keep real reads in its state root.
export function mockSpawnedChildSessionEntry(childSessionKey: string, root: string) {
  const mocks = getAgentTestMocks();
  // The real transcript target reader must stay inside this fixture's state directory.
  mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath: mocks.userTurnStorePath,
    entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
    canonicalKey: childSessionKey,
  });
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

/** Join registry completions before retiring their temporary state and native database owners. */
export async function withPluginSubagentTestState(
  prefix: string,
  run: (state: Awaited<ReturnType<typeof createOpenClawTestState>>) => Promise<void>,
): Promise<void> {
  const state = await createOpenClawTestState({ prefix, layout: "state-only" });
  try {
    resetSubagentRegistryForTests({ persist: false });
    await run(state);
  } finally {
    // Stop producers, then join admitted work before deleting storage. A failed join retains it.
    resetSubagentRegistryForTests({ persist: false });
    await vi.dynamicImportSettled();
    await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    await state.cleanup();
  }
}
