import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableWorkflowSqliteStore } from "../../durable/sqlite-store.js";
import { maybeRecordDurableGatewayStartup } from "../../durable/startup.js";
import { DURABLE_AGENT_TURN_WORKFLOW_ID } from "../../durable/workflow-ids.js";
import { durableHandlers } from "./durable.js";

describe("durable gateway methods", () => {
  it("returns coordination projection for a durable workflow run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const previousEnabled = process.env.OPENCLAW_DURABLE_WORKFLOWS;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_WORKFLOWS = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
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
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_WORKFLOWS;
      } else {
        process.env.OPENCLAW_DURABLE_WORKFLOWS = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps in-flight coordination inspectable after gateway startup reopens state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-gateway-restart-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_WORKFLOWS;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_DURABLE_WORKFLOWS = "1";
    process.env.OPENCLAW_STATE_DIR = dir;
    const store = openDurableWorkflowSqliteStore();
    let storeClosed = false;
    try {
      const parent = store.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: {
          taskId: "task-in-flight",
          taskFlowId: "flow-in-flight",
          sessionKey: "agent:bo:restart-proof",
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
        workflowId: "test.subagent",
        status: "running",
        recoveryState: "running",
        metadata: { childSessionKey: "agent:child:restart-proof" },
        now: 120,
      });
      store.createLink({
        parentWorkflowRunId: parent.workflowRunId,
        parentStepId: "subagents",
        childWorkflowRunId: child.workflowRunId,
        linkType: "subagent",
        status: "running",
        now: 130,
      });
      store.close();
      storeClosed = true;

      await maybeRecordDurableGatewayStartup({
        processInstanceId: "process-after-restart",
        startupStartedAt: 200,
        port: 0,
      });

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
          workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
          status: "waiting_child",
          recoveryState: "waiting_child",
          waitingReason: "child",
          currentStepId: "subagents",
          external: {
            taskId: "task-in-flight",
            taskFlowId: "flow-in-flight",
            sessionKey: "agent:bo:restart-proof",
          },
          children: {
            total: 1,
            running: 1,
            open: 1,
          },
        },
      });

      const verifyStore = openDurableWorkflowSqliteStore();
      try {
        expect(
          verifyStore
            .listRuns({ limit: 10 })
            .filter((run) => run.workflowId === "openclaw.gateway.startup"),
        ).toEqual([
          expect.objectContaining({
            sourceRef: "process-after-restart",
            status: "succeeded",
            recoveryState: "terminal",
          }),
        ]);
      } finally {
        verifyStore.close();
      }
    } finally {
      if (!storeClosed) {
        store.close();
      }
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_WORKFLOWS;
      } else {
        process.env.OPENCLAW_DURABLE_WORKFLOWS = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create durable state when the feature is disabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-disabled-"));
    const previousEnabled = process.env.OPENCLAW_DURABLE_WORKFLOWS;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_DURABLE_WORKFLOWS;
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const calls: unknown[][] = [];
      durableHandlers["durable.coordination.get"]?.({
        params: { workflowRunId: "wfr_disabled" },
        respond: (...args: unknown[]) => calls.push(args),
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(false);
      expect(fs.existsSync(path.join(dir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.OPENCLAW_DURABLE_WORKFLOWS;
      } else {
        process.env.OPENCLAW_DURABLE_WORKFLOWS = previousEnabled;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
