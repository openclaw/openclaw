import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createRunningTaskRun } from "./task-executor.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { getTaskById, resetTaskRegistryForTests } from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

type BackingTerminalCase = {
  backingStatus: NonNullable<SessionEntry["status"]>;
  expectedTaskStatus: "succeeded" | "failed" | "timed_out" | "cancelled";
  expectedError?: string;
  expectedTerminalSummary?: string;
};

const TERMINAL_CASES: BackingTerminalCase[] = [
  {
    backingStatus: "done",
    expectedTaskStatus: "succeeded",
    expectedTerminalSummary: "Backing session finished.",
  },
  {
    backingStatus: "failed",
    expectedTaskStatus: "failed",
    expectedError: "Backing session failed.",
  },
  {
    backingStatus: "timeout",
    expectedTaskStatus: "timed_out",
    expectedError: "Backing session timed out.",
  },
  {
    backingStatus: "killed",
    expectedTaskStatus: "cancelled",
    expectedError: "Backing session was killed.",
  },
];

async function withTaskRegistryState(run: () => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-registry-session-events-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    clearSessionStoreCacheForTest();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      await run();
    } finally {
      clearSessionStoreCacheForTest();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("task registry session lifecycle bridge", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  for (const testCase of TERMINAL_CASES) {
    it(`reconciles ${testCase.backingStatus} linked tasks on session lifecycle events`, async () => {
      await withTaskRegistryState(async () => {
        const endedAt = 4_000;
        const updatedAt = 5_000;
        const task = createRunningTaskRun({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: `run-session-event-${testCase.backingStatus}`,
          task: `Bridge ${testCase.backingStatus} child session`,
          childSessionKey: `agent:main:subagent:event-${testCase.backingStatus}`,
          progressSummary: "Captured child result",
        });
        const storePath = resolveStorePath(undefined, { agentId: "main" });
        await saveSessionStore(storePath, {
          [task.childSessionKey!]: {
            sessionId: `session-event-${testCase.backingStatus}`,
            updatedAt,
            endedAt,
            status: testCase.backingStatus,
          },
        });
        clearSessionStoreCacheForTest();

        emitSessionLifecycleEvent({
          sessionKey: task.childSessionKey!,
          reason: "subagent-status",
          parentSessionKey: task.ownerKey,
        });

        expect(getTaskById(task.taskId)).toMatchObject({
          taskId: task.taskId,
          status: testCase.expectedTaskStatus,
          endedAt,
          progressSummary: "Captured child result",
          ...(testCase.expectedError ? { error: testCase.expectedError } : {}),
          ...(testCase.expectedTerminalSummary
            ? { terminalSummary: testCase.expectedTerminalSummary }
            : {}),
        });
      });
    });
  }

  it("ignores non-terminal session lifecycle events", async () => {
    await withTaskRegistryState(async () => {
      const task = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-session-event-running",
        task: "Keep waiting on child session",
        childSessionKey: "agent:main:subagent:event-running",
      });
      const storePath = resolveStorePath(undefined, { agentId: "main" });
      await saveSessionStore(storePath, {
        [task.childSessionKey!]: {
          sessionId: "session-event-running",
          updatedAt: 2_000,
          status: "running",
        },
      });
      clearSessionStoreCacheForTest();

      emitSessionLifecycleEvent({
        sessionKey: task.childSessionKey!,
        reason: "subagent-status",
        parentSessionKey: task.ownerKey,
      });

      expect(getTaskById(task.taskId)).toMatchObject({
        taskId: task.taskId,
        status: "running",
      });
      expect(getTaskById(task.taskId)?.endedAt).toBeUndefined();
    });
  });
});
