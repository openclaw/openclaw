import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableWorkflowSqliteStore } from "../../durable/sqlite-store.js";
import { durableHandlers } from "./durable.js";

describe("durable gateway methods", () => {
  it("returns coordination projection for a durable workflow run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "workflows.sqlite");
    const previous = process.env.OPENCLAW_DURABLE_WORKFLOWS_DB_PATH;
    process.env.OPENCLAW_DURABLE_WORKFLOWS_DB_PATH = dbPath;
    const store = openDurableWorkflowSqliteStore({ path: dbPath });
    let storeClosed = false;
    try {
      const parent = store.createRun({
        workflowId: "test.parent",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskId: "task-parent",
          taskFlowId: "flow-parent",
          sessionKey: "agent:bo:main",
        },
        now: 100,
      });
      store.createStep({
        workflowRunId: parent.workflowRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        now: 110,
      });
      const child = store.createRun({
        workflowId: "test.child",
        status: "succeeded",
        recoveryState: "terminal",
        now: 120,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: "subagents",
        childWorkflowRunId: child.workflowRunId,
        linkType: "subagent",
        status: "succeeded",
        now: 130,
      });
      store.close();
      storeClosed = true;

      const calls: unknown[][] = [];
      durableHandlers["durable.coordination.get"]?.({
        params: { workflowRunId: parent.workflowRunId },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(true);
      expect(calls[0]?.[1]).toMatchObject({
        projection: {
          workflowRunId: parent.workflowRunId,
          waitingReason: "child",
          currentStepId: "subagents",
          external: {
            taskId: "task-parent",
            taskFlowId: "flow-parent",
            sessionKey: "agent:bo:main",
          },
          children: {
            total: 1,
            succeeded: 1,
            terminal: 1,
            open: 0,
          },
        },
      });
    } finally {
      if (!storeClosed) {
        store.close();
      }
      if (previous === undefined) {
        delete process.env.OPENCLAW_DURABLE_WORKFLOWS_DB_PATH;
      } else {
        process.env.OPENCLAW_DURABLE_WORKFLOWS_DB_PATH = previous;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
