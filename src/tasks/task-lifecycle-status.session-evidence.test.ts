import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createRunningTaskRun } from "./task-executor.js";
import {
  resolveTaskFlowLifecycleStatusReason,
  resolveTaskLifecycleStatusReason,
} from "./task-lifecycle-status.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const NOW = 1_000_000_000_000;

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-1",
    runId: "run-1",
    task: "default task",
    runtime: "subagent",
    status: "running",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    createdAt: NOW - 1_000,
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    ...overrides,
  };
}

async function withBackingSessionStore(
  entries: Record<string, SessionEntry>,
  run: () => Promise<void> | void,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-lifecycle-status-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    clearSessionStoreCacheForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await saveSessionStore(storePath, entries);
    try {
      await run();
    } finally {
      clearSessionStoreCacheForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
    }
  });
}

describe("task lifecycle status session evidence", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
  });

  it("distinguishes expected waiting when the backing child session is still running", async () => {
    await withBackingSessionStore(
      {
        "agent:main:subagent:child-live": {
          sessionId: "session-live",
          updatedAt: NOW,
          status: "running",
        },
      },
      () => {
        const reason = resolveTaskLifecycleStatusReason(
          makeTask({
            childSessionKey: "agent:main:subagent:child-live",
          }),
        );

        expect(reason).toMatchObject({
          code: "waiting_on_backing_session",
          summary: "Backing session is running.",
          backing: expect.arrayContaining([
            {
              kind: "session",
              relation: "child_session",
              id: "agent:main:subagent:child-live",
            },
          ]),
          evidence: expect.arrayContaining([
            expect.objectContaining({
              kind: "session_state",
              summary: "Backing session is running.",
              data: {
                state: "running",
                source: "session_status",
              },
              recordedAt: NOW,
            }),
          ]),
        });
      },
    );
  });

  it("surfaces blocked-on-session-state when the backing child session already failed", async () => {
    await withBackingSessionStore(
      {
        "agent:main:subagent:child-failed": {
          sessionId: "session-failed",
          updatedAt: NOW,
          status: "failed",
        },
      },
      () => {
        const reason = resolveTaskLifecycleStatusReason(
          makeTask({
            childSessionKey: "agent:main:subagent:child-failed",
          }),
        );

        expect(reason).toMatchObject({
          code: "blocked_on_backing_session_state",
          summary: "Backing session failed; task has not reconciled yet.",
          evidence: expect.arrayContaining([
            expect.objectContaining({
              kind: "session_state",
              data: {
                state: "failed",
                source: "session_status",
              },
            }),
          ]),
        });
      },
    );
  });

  it("surfaces missing backing session evidence before the task is fully reconciled lost", async () => {
    await withBackingSessionStore({}, () => {
      const reason = resolveTaskLifecycleStatusReason(
        makeTask({
          childSessionKey: "agent:main:subagent:child-missing",
        }),
      );

      expect(reason).toMatchObject({
        code: "missing_backing_session",
        summary: "Backing session is missing; task may be orphaned.",
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "session_state",
            data: {
              state: "missing",
              source: "missing",
            },
          }),
        ]),
      });
    });
  });

  it("bridges linked task session evidence into waiting flow reasons", async () => {
    await withBackingSessionStore({}, () => {
      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-flow-wait-child",
        task: "Wait for child result",
        childSessionKey: "agent:main:subagent:child-missing",
        lastEventAt: NOW,
      });

      const reason = resolveTaskFlowLifecycleStatusReason({
        flow: {
          ownerKey: "agent:main:main",
          status: "waiting",
          waitJson: { kind: "task", taskId: child.taskId },
          updatedAt: NOW,
        },
      });

      expect(reason).toMatchObject({
        code: "waiting_on_task",
        summary: "Waiting on task: Backing session is missing; task may be orphaned.",
        backing: expect.arrayContaining([
          { kind: "task", relation: "wait_task", id: child.taskId },
        ]),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "linked_task_reason",
            summary: "Backing session is missing; task may be orphaned.",
            data: {
              relation: "wait_task",
              taskId: child.taskId,
              code: "missing_backing_session",
            },
          }),
        ]),
      });
    });
  });
});
