import { describe, expect, it } from "vitest";
import {
  buildDurableCoordinationMetadataProjection,
  buildDurableCoordinationProjection,
  mergeDurableProjectionIntoJsonObject,
} from "./coordination-projection.js";
import type { DurableRuntimeLink, DurableRuntimeRun, DurableRuntimeStep } from "./types.js";

describe("durable coordination projection", () => {
  it("summarizes waiting child runs for runtime consumers", () => {
    const run: DurableRuntimeRun = {
      runtimeRunId: "rt_parent",
      operationKind: "openclaw.agent.turn",
      operationVersion: "1",
      status: "waiting_child",
      recoveryState: "waiting_child",
      sourceType: "agent_turn",
      sourceRef: "agent:bo:discord:channel:bo-main",
      workUnitId: "wu:test:card-parent",
      reportRouteId: "discord:bo-main",
      heartbeatAt: 120,
      metadata: {
        taskId: "task_parent",
        taskFlowId: "flow_parent",
        agentId: "bo",
      },
      createdAt: 100,
      updatedAt: 150,
    };
    const steps: DurableRuntimeStep[] = [
      {
        runtimeRunId: run.runtimeRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        attempt: 1,
        createdAt: 110,
        updatedAt: 140,
      },
    ];
    const childLinks: DurableRuntimeLink[] = [
      {
        parentRuntimeRunId: run.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: "rt_child_1",
        linkType: "subagent",
        status: "succeeded",
        createdAt: 120,
        updatedAt: 130,
      },
      {
        parentRuntimeRunId: run.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: "rt_child_2",
        linkType: "subagent",
        status: "failed",
        createdAt: 121,
        updatedAt: 131,
      },
      {
        parentRuntimeRunId: run.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: "rt_child_3",
        linkType: "subagent",
        status: "running",
        createdAt: 122,
        updatedAt: 132,
      },
    ];

    const projection = buildDurableCoordinationProjection({ run, steps, childLinks });

    expect(projection).toMatchObject({
      runtimeRunId: "rt_parent",
      workUnitId: "wu:test:card-parent",
      reportRouteId: "discord:bo-main",
      status: "waiting_child",
      recoveryState: "waiting_child",
      currentStepId: "subagents",
      waitingReason: "child",
      external: {
        workUnitId: "wu:test:card-parent",
        reportRouteId: "discord:bo-main",
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
        canCancel: false,
        canRetry: false,
        canResume: false,
        canSignal: false,
        canOpenTimeline: true,
      },
    });

    expect(buildDurableCoordinationMetadataProjection(projection)).toMatchObject({
      runtimeRunId: "rt_parent",
      workUnitId: "wu:test:card-parent",
      reportRouteId: "discord:bo-main",
      waitingReason: "child",
      children: { open: 1, failed: 1 },
    });
    expect(
      mergeDurableProjectionIntoJsonObject(
        { existing: true },
        buildDurableCoordinationMetadataProjection(projection),
      ),
    ).toMatchObject({
      existing: true,
      durable: {
        runtimeRunId: "rt_parent",
      },
    });
  });

  it("exposes recovery diagnostics for lost runs without requiring a product surface", () => {
    const run: DurableRuntimeRun = {
      runtimeRunId: "rt_lost",
      operationKind: "openclaw.agent.turn",
      operationVersion: "1",
      status: "lost",
      recoveryState: "lost",
      sourceType: "agent",
      sourceRef: "agent:bo:direct",
      metadata: {
        sessionKey: "agent:bo:direct",
        recoveryDiagnostic: {
          state: "lost",
          severity: "error",
          reportable: true,
          retryable: true,
          reason: "gateway_startup_reconciliation",
          message: "Agent turn was marked lost during durable recovery.",
          nextAction: "inspect_timeline_then_retry_or_resume",
          safeRecoveryActions: ["inspect_timeline", "retry_request"],
          input: {
            inputRef: "agent-turn:lost:input",
            inputAvailability: "preview_only",
            canReplay: false,
            reason: "bounded preview only",
            messageLength: 12,
            messageHash: "hash-lost",
          },
          detectedAt: 200,
          processInstanceId: "process-1",
        },
      },
      createdAt: 100,
      updatedAt: 200,
      completedAt: 200,
    };

    const projection = buildDurableCoordinationProjection({ run });

    expect(projection).toMatchObject({
      runtimeRunId: "rt_lost",
      status: "lost",
      recoveryState: "lost",
      external: {
        sessionKey: "agent:bo:direct",
      },
      controls: {
        canCancel: false,
        canRetry: false,
        canResume: false,
        canSignal: false,
        canOpenTimeline: true,
      },
      recovery: {
        state: "lost",
        severity: "error",
        reportable: true,
        retryable: true,
        reason: "gateway_startup_reconciliation",
        nextAction: "inspect_timeline_then_retry_or_resume",
        safeRecoveryActions: ["inspect_timeline", "retry_request"],
        input: {
          inputRef: "agent-turn:lost:input",
          inputAvailability: "preview_only",
          canReplay: false,
          reason: "bounded preview only",
          messageLength: 12,
          messageHash: "hash-lost",
        },
      },
    });
    expect(buildDurableCoordinationMetadataProjection(projection)).toMatchObject({
      recovery: {
        state: "lost",
        nextAction: "inspect_timeline_then_retry_or_resume",
      },
    });
  });
});
