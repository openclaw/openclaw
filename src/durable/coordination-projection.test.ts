import { describe, expect, it } from "vitest";
import {
  buildDurableCoordinationProjection,
  buildDurableTaskFlowStateProjection,
  buildDurableWorkboardMetadataProjection,
  mergeDurableProjectionIntoJsonObject,
} from "./coordination-projection.js";
import type { DurableWorkflowLink, DurableWorkflowRun, DurableWorkflowStep } from "./types.js";

describe("durable coordination projection", () => {
  it("summarizes waiting child runs for taskflow and workboard consumers", () => {
    const run: DurableWorkflowRun = {
      workflowRunId: "wfr_parent",
      workflowId: "openclaw.agent.turn",
      workflowVersion: "1",
      status: "waiting_child",
      recoveryState: "waiting_child",
      sourceType: "agent_turn",
      sourceRef: "agent:bo:discord:channel:bo-main",
      heartbeatAt: 120,
      metadata: {
        taskId: "task_parent",
        taskFlowId: "flow_parent",
        agentId: "bo",
      },
      createdAt: 100,
      updatedAt: 150,
    };
    const steps: DurableWorkflowStep[] = [
      {
        workflowRunId: run.workflowRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        attempt: 1,
        createdAt: 110,
        updatedAt: 140,
      },
    ];
    const childLinks: DurableWorkflowLink[] = [
      {
        parentWorkflowRunId: run.workflowRunId,
        parentStepId: "subagents",
        childWorkflowRunId: "wfr_child_1",
        linkType: "subagent",
        status: "succeeded",
        createdAt: 120,
        updatedAt: 130,
      },
      {
        parentWorkflowRunId: run.workflowRunId,
        parentStepId: "subagents",
        childWorkflowRunId: "wfr_child_2",
        linkType: "subagent",
        status: "failed",
        createdAt: 121,
        updatedAt: 131,
      },
      {
        parentWorkflowRunId: run.workflowRunId,
        parentStepId: "subagents",
        childWorkflowRunId: "wfr_child_3",
        linkType: "subagent",
        status: "running",
        createdAt: 122,
        updatedAt: 132,
      },
    ];

    const projection = buildDurableCoordinationProjection({ run, steps, childLinks });

    expect(projection).toMatchObject({
      workflowRunId: "wfr_parent",
      status: "waiting_child",
      recoveryState: "waiting_child",
      currentStepId: "subagents",
      waitingReason: "child",
      external: {
        taskId: "task_parent",
        taskFlowId: "flow_parent",
        sessionKey: "agent:bo:discord:channel:bo-main",
        agentId: "bo",
      },
      children: {
        total: 3,
        succeeded: 1,
        failed: 1,
        running: 1,
        terminal: 2,
        open: 1,
      },
      controls: {
        canCancel: true,
        canResume: true,
        canOpenTimeline: true,
      },
    });

    expect(buildDurableTaskFlowStateProjection(projection)).toMatchObject({
      workflowRunId: "wfr_parent",
      waitingReason: "child",
      children: { open: 1, failed: 1 },
    });
    expect(buildDurableWorkboardMetadataProjection(projection)).toMatchObject({
      workflowRunId: "wfr_parent",
      taskId: "task_parent",
      taskFlowId: "flow_parent",
      timelineCommand: "openclaw durable timeline wfr_parent",
    });
    expect(
      mergeDurableProjectionIntoJsonObject(
        { existing: true },
        buildDurableTaskFlowStateProjection(projection),
      ),
    ).toMatchObject({
      existing: true,
      durable: {
        workflowRunId: "wfr_parent",
      },
    });
  });
});
