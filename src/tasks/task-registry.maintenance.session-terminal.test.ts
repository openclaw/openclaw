import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createRunningTaskRun } from "./task-executor.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { getTaskById, resetTaskRegistryForTests } from "./task-registry.js";
import {
  reconcileInspectableTasks,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";

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
  await withTempDir({ prefix: "openclaw-task-registry-session-terminal-" }, async (root) => {
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

describe("task registry maintenance session terminal bridge", () => {
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
    it(`projects ${testCase.backingStatus} backing-session evidence during operator inspection without mutating the registry`, async () => {
      await withTaskRegistryState(async () => {
        const task = createRunningTaskRun({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: `run-inspect-${testCase.backingStatus}`,
          task: `Inspect ${testCase.backingStatus} child session`,
          childSessionKey: `agent:main:subagent:inspect-${testCase.backingStatus}`,
        });
        const storePath = resolveStorePath(undefined, { agentId: "main" });
        await saveSessionStore(storePath, {
          [task.childSessionKey!]: {
            sessionId: `session-inspect-${testCase.backingStatus}`,
            updatedAt: Date.now(),
            status: testCase.backingStatus,
          },
        });
        clearSessionStoreCacheForTest();

        const [projected] = reconcileInspectableTasks();

        expect(projected).toMatchObject({
          taskId: task.taskId,
          status: testCase.expectedTaskStatus,
          ...(testCase.expectedError ? { error: testCase.expectedError } : {}),
          ...(testCase.expectedTerminalSummary
            ? { terminalSummary: testCase.expectedTerminalSummary }
            : {}),
        });
        expect(projected.cleanupAfter).toBeGreaterThan(projected.endedAt ?? 0);
        expect(getTaskById(task.taskId)).toMatchObject({
          status: "running",
        });
      });
    });

    it(`applies ${testCase.backingStatus} backing-session evidence during maintenance`, async () => {
      await withTaskRegistryState(async () => {
        const task = createRunningTaskRun({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: `run-maint-${testCase.backingStatus}`,
          task: `Maintain ${testCase.backingStatus} child session`,
          childSessionKey: `agent:main:subagent:maint-${testCase.backingStatus}`,
        });
        const storePath = resolveStorePath(undefined, { agentId: "main" });
        await saveSessionStore(storePath, {
          [task.childSessionKey!]: {
            sessionId: `session-maint-${testCase.backingStatus}`,
            updatedAt: Date.now(),
            status: testCase.backingStatus,
          },
        });
        clearSessionStoreCacheForTest();

        await expect(runTaskRegistryMaintenance()).resolves.toEqual({
          reconciled: 1,
          cleanupStamped: 0,
          pruned: 0,
        });
        expect(getTaskById(task.taskId)).toMatchObject({
          status: testCase.expectedTaskStatus,
          ...(testCase.expectedError ? { error: testCase.expectedError } : {}),
          ...(testCase.expectedTerminalSummary
            ? { terminalSummary: testCase.expectedTerminalSummary }
            : {}),
        });
        expect(getTaskById(task.taskId)?.cleanupAfter).toBeGreaterThan(Date.now());
      });
    });
  }
});
