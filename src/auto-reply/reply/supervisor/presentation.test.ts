import { describe, expect, it } from "vitest";
import {
  buildSupervisorPresentationPlannedOutcomePayload,
  buildSupervisorPresentationSummary,
  buildSupervisorStatusPayload,
  buildSupervisorStatusOutcomePayload,
  getSupervisorMilestoneModelInputDraft,
  getSupervisorPresentationPlanItem,
  planSupervisorPresentation,
  renderSupervisorPresentationTemplate,
} from "./presentation.js";

describe("planSupervisorPresentation", () => {
  const baseEvent = {
    type: "user_message",
    category: "user" as const,
    source: "telegram",
    timestamp: 1,
    payload: { text: "actually switch to the outage" },
    urgency: "normal" as const,
    scope: "foreground" as const,
  };

  const baseTaskState = {
    sessionKey: "agent:main:thread-1",
    sessionId: "sess-1",
    phase: "acting" as const,
    interruptPreference: "avoid" as const,
    interruptibility: "interruptible" as const,
    isActive: true,
    isStreaming: true,
    laneSize: 0,
  };

  it("uses templated ack and status for same-task supplements", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "budget cap is 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
    });

    expect(plan.profile).toBe("balanced");
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ack",
          enabled: true,
          mode: "template",
          templateId: "ack.received",
          latencyClass: "reflex",
        }),
        expect.objectContaining({
          kind: "status",
          enabled: true,
          mode: "template",
          templateId: "status.updating_current_task",
          latencyClass: "interactive",
          reason: "same-task supplements should surface that the new constraint was absorbed",
          userQuestion: "Did you absorb my new constraint or material?",
          semanticRole: "Confirm that the new detail was folded into the current task.",
        }),
        expect.objectContaining({
          kind: "milestone",
          enabled: false,
          mode: "none",
        }),
      ]),
    );
  });

  it("marks replacement as a modeled milestone candidate", () => {
    const plan = planSupervisorPresentation({
      event: baseEvent,
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      profile: "aggressive",
      runtimeDisposition: "preempting_active_run",
    });

    expect(plan.profile).toBe("aggressive");
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: true,
          templateId: "status.switching_to_new_task",
        }),
        expect.objectContaining({
          kind: "milestone",
          enabled: true,
          mode: "model",
          latencyClass: "deliberative",
          userQuestion: "Did you drop the old task and switch focus?",
          semanticRole:
            "Only surface progress if the replacement task is long enough or yields a useful early result.",
          modelPromptHint:
            "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
          modelInputDraft: {
            audience_question: "Did you drop the old task and switch focus?",
            semantic_role:
              "Only surface progress if the replacement task is long enough or yields a useful early result.",
            prompt_hint:
              "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
            suppress_reason: undefined,
          },
        }),
      ]),
    );
  });

  it("suppresses status for non-user defer paths that are not foreground-active", () => {
    const plan = planSupervisorPresentation({
      event: {
        type: "timer_fired",
        category: "time",
        source: "scheduler",
        timestamp: 1,
        payload: {},
        urgency: "low",
        scope: "background",
      },
      taskState: { ...baseTaskState, phase: "waiting" },
      relation: "background_relevant",
      action: "defer",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ack",
          enabled: false,
          mode: "none",
        }),
        expect.objectContaining({
          kind: "status",
          enabled: false,
          mode: "none",
        }),
        expect.objectContaining({
          kind: "milestone",
          enabled: false,
          mode: "none",
        }),
      ]),
    );
  });

  it("keeps defer status only while an active foreground task is being preserved", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "keep this link for later" } },
      taskState: { ...baseTaskState, phase: "acting", isActive: true },
      relation: "background_relevant",
      action: "defer",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: true,
          templateId: "status.defer_for_later",
          reason: "only foreground-preserving defer paths should surface a status",
        }),
      ]),
    );
    expect(buildSupervisorStatusPayload(plan)).toEqual({
      text: "我先记下这件事，等当前任务处理完再接着看。",
    });
  });

  it("renders deterministic status templates into reply payloads", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "please focus on the outage instead" } },
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      runtimeDisposition: "preempting_active_run",
    });

    expect(renderSupervisorPresentationTemplate("status.switching_to_new_task")).toBe(
      "我现在切到这个新任务上。",
    );
    expect(renderSupervisorPresentationTemplate("status.updating_current_task")).toBe(
      "我会把你刚补充的信息并入当前任务。",
    );
    expect(renderSupervisorPresentationTemplate("status.redirecting_current_task")).toBe(
      "我会按你的修正调整当前任务方向。",
    );
    expect(buildSupervisorStatusPayload(plan)).toEqual({
      text: "我现在切到这个新任务上。",
    });
  });

  it("suppresses status for low-value continue paths", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "by the way" } },
      taskState: { ...baseTaskState, phase: "idle", isActive: false, isStreaming: false },
      relation: "unrelated",
      action: "continue",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: false,
          mode: "none",
          reason: "no intermediate status is needed for this path",
        }),
      ]),
    );
    expect(buildSupervisorStatusPayload(plan)).toBeUndefined();
  });

  it("suppresses replacement presentation until runtime can really preempt", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "先别做刚才那个" } },
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      runtimeDisposition: "non_preemptive",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: false,
          mode: "none",
          reason: "no intermediate status is needed for this path",
        }),
        expect.objectContaining({
          kind: "milestone",
          enabled: false,
          mode: "none",
          reason: "routine append, steer, continue, and defer flows should skip milestone emission",
        }),
      ]),
    );
    expect(buildSupervisorStatusPayload(plan)).toBeUndefined();
  });

  it("keeps continue status only for explicit same-task control", () => {
    const controlPlan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "continue" } },
      taskState: baseTaskState,
      relation: "same_task_control",
      action: "continue",
    });
    const passivePlan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "ok" } },
      taskState: baseTaskState,
      relation: "background_relevant",
      action: "continue",
    });

    expect(controlPlan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: true,
          templateId: "status.continuing",
          reason: "explicit control-like input can use a deterministic continue status",
        }),
      ]),
    );
    expect(buildSupervisorStatusPayload(controlPlan)).toEqual({
      text: "按你的要求继续当前任务。",
    });
    expect(buildSupervisorStatusPayload(passivePlan)).toBeUndefined();
  });

  it("attaches milestone semantics for forked-task planning", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "顺手也查一下这个域名归谁" } },
      taskState: baseTaskState,
      relation: "new_task_parallel",
      action: "pause_and_fork",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "milestone",
          enabled: true,
          userQuestion: "Did you preserve the current task while opening a side branch?",
          semanticRole:
            "Surface progress only when the new branch reaches a meaningful checkpoint.",
          modelPromptHint:
            "If a milestone is shown, make it clear that the side branch progressed while the original task stayed resumable.",
          modelInputDraft: {
            audience_question: "Did you preserve the current task while opening a side branch?",
            semantic_role:
              "Surface progress only when the new branch reaches a meaningful checkpoint.",
            prompt_hint:
              "If a milestone is shown, make it clear that the side branch progressed while the original task stayed resumable.",
            suppress_reason: undefined,
          },
        }),
      ]),
    );
  });

  it("keeps a suppressed milestone draft with an explicit suppress reason", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "预算上限 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "milestone",
          enabled: false,
          modelInputDraft: {
            audience_question: "Did you absorb my new constraint or material?",
            semantic_role:
              "Only surface visible progress if the added material changes the work product.",
            prompt_hint:
              "Only narrate progress if the added detail materially changes the visible work.",
            suppress_reason:
              "routine append, steer, continue, and defer flows should skip milestone emission",
          },
        }),
      ]),
    );
    expect(getSupervisorMilestoneModelInputDraft(plan)).toEqual({
      audience_question: "Did you absorb my new constraint or material?",
      semantic_role:
        "Only surface visible progress if the added material changes the work product.",
      prompt_hint: "Only narrate progress if the added detail materially changes the visible work.",
      suppress_reason:
        "routine append, steer, continue, and defer flows should skip milestone emission",
    });
  });

  it("provides stable helpers for plan item lookup", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "顺手也查一下这个域名归谁" } },
      taskState: baseTaskState,
      relation: "new_task_parallel",
      action: "pause_and_fork",
    });

    expect(getSupervisorPresentationPlanItem(plan, "status")).toEqual(
      expect.objectContaining({
        templateId: "status.opening_side_task",
      }),
    );
    expect(getSupervisorMilestoneModelInputDraft(plan)).toEqual(
      expect.objectContaining({
        audience_question: "Did you preserve the current task while opening a side branch?",
      }),
    );
  });

  it("builds an analysis-friendly presentation summary", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "顺手也查一下这个域名归谁" } },
      taskState: baseTaskState,
      relation: "new_task_parallel",
      action: "pause_and_fork",
    });

    expect(
      buildSupervisorPresentationSummary({
        plan,
        statusScheduledForRuntime: true,
      }),
    ).toEqual({
      status: {
        planned: true,
        scheduled_for_runtime: true,
        templateId: "status.opening_side_task",
        suppress_reason: undefined,
      },
      milestone: {
        planned: true,
        eligible_for_runtime: true,
        scheduled_for_runtime: false,
        has_model_input_draft: true,
        suppress_reason: undefined,
      },
    });
  });

  it("builds typed presentation outcome payloads", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "顺手也查一下这个域名归谁" } },
      taskState: baseTaskState,
      relation: "new_task_parallel",
      action: "pause_and_fork",
    });
    const summary = buildSupervisorPresentationSummary({
      plan,
      statusScheduledForRuntime: true,
    });

    expect(buildSupervisorPresentationPlannedOutcomePayload(summary)).toEqual({
      summary,
    });
    expect(
      buildSupervisorStatusOutcomePayload({
        plan,
        scheduledForRuntime: true,
      }),
    ).toEqual({
      templateId: "status.opening_side_task",
    });
  });

  it("suppresses status for internal webchat delivery", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "budget cap is 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
      delivery: "internal_webchat",
    });

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          enabled: false,
          mode: "none",
          reason: "status is suppressed when the turn is not routable to an external channel",
        }),
      ]),
    );
    expect(buildSupervisorStatusPayload(plan)).toBeUndefined();
  });
});
