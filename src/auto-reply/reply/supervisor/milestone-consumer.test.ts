import { describe, expect, it } from "vitest";
import {
  consumeSupervisorMilestoneDraft,
  prepareSupervisorMilestonePrompt,
} from "./milestone-consumer.js";
import { planSupervisorPresentation } from "./presentation.js";

describe("consumeSupervisorMilestoneDraft", () => {
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

  it("returns a consumable draft when milestone planning is enabled", () => {
    const plan = planSupervisorPresentation({
      event: baseEvent,
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      runtimeDisposition: "preempting_active_run",
    });

    expect(consumeSupervisorMilestoneDraft({ plan })).toEqual({
      consumed: true,
      draft: {
        audience_question: "Did you drop the old task and switch focus?",
        semantic_role:
          "Only surface progress if the replacement task is long enough or yields a useful early result.",
        prompt_hint:
          "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
        suppress_reason: undefined,
      },
      item: expect.objectContaining({
        kind: "milestone",
        enabled: true,
        mode: "model",
      }),
    });
  });

  it("returns a suppressed draft without consuming it when milestone planning is disabled", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "预算上限 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
    });

    expect(consumeSupervisorMilestoneDraft({ plan })).toEqual({
      consumed: false,
      reason: "routine append, steer, continue, and defer flows should skip milestone emission",
      draft: {
        audience_question: "Did you absorb my new constraint or material?",
        semantic_role:
          "Only surface visible progress if the added material changes the work product.",
        prompt_hint:
          "Only narrate progress if the added detail materially changes the visible work.",
        suppress_reason:
          "routine append, steer, continue, and defer flows should skip milestone emission",
      },
    });
  });

  it("prepares stable prompt slots without consuming a model at runtime", () => {
    const enabledPlan = planSupervisorPresentation({
      event: baseEvent,
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      runtimeDisposition: "preempting_active_run",
    });
    const suppressedPlan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "预算上限 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
    });

    expect(prepareSupervisorMilestonePrompt({ plan: enabledPlan })).toEqual({
      prepared: true,
      draft: {
        audience_question: "Did you drop the old task and switch focus?",
        semantic_role:
          "Only surface progress if the replacement task is long enough or yields a useful early result.",
        prompt_hint:
          "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
        suppress_reason: undefined,
      },
      item: expect.objectContaining({
        kind: "milestone",
        enabled: true,
      }),
      prompt: {
        audience_question: "Did you drop the old task and switch focus?",
        semantic_role:
          "Only surface progress if the replacement task is long enough or yields a useful early result.",
        prompt_hint:
          "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
      },
      runtimeEnvelope: {
        prompt_slots: {
          audience_question: "Did you drop the old task and switch focus?",
          semantic_role:
            "Only surface progress if the replacement task is long enough or yields a useful early result.",
          prompt_hint:
            "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
        },
        planner: {
          suppress_reason: undefined,
          semantic_role:
            "Only surface progress if the replacement task is long enough or yields a useful early result.",
        },
      },
    });

    expect(prepareSupervisorMilestonePrompt({ plan: suppressedPlan })).toEqual({
      prepared: false,
      reason: "routine append, steer, continue, and defer flows should skip milestone emission",
      draft: {
        audience_question: "Did you absorb my new constraint or material?",
        semantic_role:
          "Only surface visible progress if the added material changes the work product.",
        prompt_hint:
          "Only narrate progress if the added detail materially changes the visible work.",
        suppress_reason:
          "routine append, steer, continue, and defer flows should skip milestone emission",
      },
      prompt: {
        audience_question: "Did you absorb my new constraint or material?",
        semantic_role:
          "Only surface visible progress if the added material changes the work product.",
        prompt_hint:
          "Only narrate progress if the added detail materially changes the visible work.",
      },
      runtimeEnvelope: {
        prompt_slots: {
          audience_question: "Did you absorb my new constraint or material?",
          semantic_role:
            "Only surface visible progress if the added material changes the work product.",
          prompt_hint:
            "Only narrate progress if the added detail materially changes the visible work.",
        },
        planner: {
          suppress_reason:
            "routine append, steer, continue, and defer flows should skip milestone emission",
          semantic_role:
            "Only surface visible progress if the added material changes the work product.",
        },
      },
    });
  });
});
