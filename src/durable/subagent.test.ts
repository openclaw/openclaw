import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";
import { recordDurableSubagentRegistered, recordDurableSubagentTerminal } from "./subagent.js";
import {
  DURABLE_AGENT_TURN_WORKFLOW_ID,
  DURABLE_SUBAGENT_RUN_WORKFLOW_ID,
} from "./workflow-ids.js";

describe("durable subagent bridge", () => {
  it("preserves background task and taskflow bindings on child runs and parent links", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "workflows.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_WORKFLOWS: "1",
      OPENCLAW_DURABLE_WORKFLOWS_DB_PATH: dbPath,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const childSessionKey = "agent:bo:subagent:workboard-default-card";

    const setupStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      taskId: "task_child",
      taskFlowId: "flow_child",
      task: "Summarize durable bridge",
      label: "durable bridge",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    recordDurableSubagentTerminal({
      runId: "run_child",
      childSessionKey,
      status: "success",
      summary: "done",
      env,
    });

    const assertStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.workflowId === DURABLE_SUBAGENT_RUN_WORKFLOW_ID);
      expect(child).toMatchObject({
        status: "succeeded",
        metadata: {
          runId: "run_child",
          taskId: "task_child",
          taskFlowId: "flow_child",
          childSessionKey,
          agentId: "bo",
          requesterAgentId: "bo",
          summary: "done",
        },
      });
      expect(child).toBeDefined();
      const parentLink = assertStore.listParentLinks(child!.workflowRunId)[0];
      expect(parentLink).toMatchObject({
        status: "succeeded",
        metadata: {
          runId: "run_child",
          taskId: "task_child",
          taskFlowId: "flow_child",
          childSessionKey,
          summary: "done",
        },
      });
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
