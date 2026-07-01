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
  it("links children to the active requester run when same-session parents overlap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_WORKFLOWS: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";

    let olderParentId = "";
    let activeParentId = "";
    const setupStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      olderParentId = setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_old",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      }).workflowRunId;
      activeParentId = setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_active",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 200,
      }).workflowRunId;
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey: "agent:bo:subagent:active-child",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent_active",
      task: "Check active parent binding",
      label: "active parent",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    const assertStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.workflowId === DURABLE_SUBAGENT_RUN_WORKFLOW_ID);
      expect(child).toBeDefined();
      expect(child?.parentWorkflowRunId).toBe(activeParentId);
      expect(child?.parentWorkflowRunId).not.toBe(olderParentId);
      expect(assertStore.listChildLinks(activeParentId)).toMatchObject([
        {
          childWorkflowRunId: child?.workflowRunId,
          status: "running",
        },
      ]);
      expect(assertStore.listChildLinks(olderParentId)).toEqual([]);
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the newest same-session parent when requester run id is unavailable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_WORKFLOWS: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";

    let newerParentId = "";
    const setupStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_old",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
      newerParentId = setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_new",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 200,
      }).workflowRunId;
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey: "agent:bo:subagent:newest-child",
      requesterSessionKey: parentSessionKey,
      task: "Check newest parent binding",
      label: "newest parent",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    const assertStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.workflowId === DURABLE_SUBAGENT_RUN_WORKFLOW_ID);
      expect(child).toBeDefined();
      expect(child?.parentWorkflowRunId).toBe(newerParentId);
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves background task and taskflow bindings on child runs and parent links", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_WORKFLOWS: "1",
      OPENCLAW_STATE_DIR: dir,
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
      status: "ok",
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
          taskHash: expect.any(String),
          childSessionKey,
          status: "ok",
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
          taskHash: expect.any(String),
          childSessionKey,
          status: "ok",
          summary: "done",
        },
      });
      expect(child?.metadata?.task).toBeUndefined();
      expect(parentLink?.metadata?.task).toBeUndefined();
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens parent fan-in when a later child starts after an earlier child completed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_WORKFLOWS: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const setupStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_a",
      childSessionKey: "agent:bo:subagent:child-a",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "First child",
      env,
    });
    recordDurableSubagentTerminal({
      runId: "run_child_a",
      childSessionKey: "agent:bo:subagent:child-a",
      status: "success",
      summary: "child a done",
      env,
    });
    recordDurableSubagentRegistered({
      runId: "run_child_b",
      childSessionKey: "agent:bo:subagent:child-b",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "Second child",
      env,
    });

    const assertStore = openDurableWorkflowSqliteStore({ path: dbPath });
    try {
      const parent = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.workflowId === DURABLE_AGENT_TURN_WORKFLOW_ID);
      expect(parent).toMatchObject({
        status: "waiting_child",
        recoveryState: "waiting_child",
      });
      expect(parent?.completedAt).toBeUndefined();
      const fanInStep = assertStore
        .listSteps(parent!.workflowRunId)
        .find((step) => step.stepId === "subagents");
      expect(fanInStep).toMatchObject({
        stepId: "subagents",
        status: "waiting",
        recoveryState: "waiting_child",
      });
      expect(fanInStep?.completedAt).toBeUndefined();
      expect(assertStore.listChildLinks(parent!.workflowRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded" }),
          expect.objectContaining({ status: "running" }),
        ]),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
