import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunningTaskRun } from "../../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-flow-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { taskHandlers } from "./tasks.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withTaskState(test: () => Promise<void>) {
  await withStateDirEnv("openclaw-task-handlers-", async () => {
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
    await test();
    resetTaskFlowRegistryForTests();
    resetTaskRegistryForTests();
  });
}

afterEach(() => {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  resetTaskFlowRegistryForTests();
  resetTaskRegistryForTests();
});

describe("taskHandlers", () => {
  it("returns the latest owner-scoped flow detail", async () => {
    await withTaskState(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-handlers/latest",
        goal: "Inspect failed long task",
        status: "blocked",
        currentStep: "waiting for user",
        createdAt: 10,
        updatedAt: 20,
      });
      createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-flow-1",
        task: "Inspect task",
        startedAt: 10,
        lastEventAt: 20,
        progressSummary: "Waiting on user reply",
      });

      const respond = vi.fn();
      await taskHandlers["tasks.flows.findLatest"]({
        req: {
          method: "tasks.flows.findLatest",
          params: { sessionKey: "agent:main:main" },
        } as never,
        params: { sessionKey: "agent:main:main" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as never,
      });

      const [ok, payload] = respond.mock.calls.at(-1) ?? [];
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        flow: {
          id: flow.flowId,
          goal: "Inspect failed long task",
          status: "blocked",
          currentStep: "waiting for user",
          tasks: [
            {
              id: expect.any(String),
              runtime: "subagent",
              progressSummary: "Waiting on user reply",
            },
          ],
        },
      });
    });
  });

  it("keeps retry owner-scoped and returns a non-success reason", async () => {
    await withTaskState(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-handlers/retry",
        goal: "Retry me",
        status: "failed",
        stateJson: {
          task: "Retry me",
          runtime: "subagent",
        },
        createdAt: 10,
        updatedAt: 20,
        endedAt: 20,
      });

      const respond = vi.fn();
      await taskHandlers["tasks.flows.retry"]({
        req: {
          method: "tasks.flows.retry",
          params: { sessionKey: "agent:main:other", flowId: flow.flowId },
        } as never,
        params: { sessionKey: "agent:main:other", flowId: flow.flowId },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as never,
      });

      const [ok, payload] = respond.mock.calls.at(-1) ?? [];
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        found: false,
        retried: false,
        reason: "Flow not found.",
        flow: null,
      });
    });
  });
});
