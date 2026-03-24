import { describe, expect, it } from "vitest";
import {
  buildSupervisorMilestoneOutcomePayload,
  prepareSupervisorMilestoneRuntimeRequest,
} from "./milestone-runtime.js";
import { planSupervisorPresentation } from "./presentation.js";

describe("prepareSupervisorMilestoneRuntimeRequest", () => {
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

  it("produces a direct runtime request from an enabled milestone plan", () => {
    const plan = planSupervisorPresentation({
      event: baseEvent,
      taskState: baseTaskState,
      relation: "new_task_replace",
      action: "abort_and_replace",
      runtimeDisposition: "preempting_active_run",
    });

    const result = prepareSupervisorMilestoneRuntimeRequest({ plan });
    expect(result).toEqual({
      ready: true,
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
      runtimeRequest: {
        kind: "supervisor_milestone",
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
  });

  it("keeps a suppressed runtime request draft for analysis without enabling runtime emission", () => {
    const plan = planSupervisorPresentation({
      event: { ...baseEvent, payload: { text: "预算上限 3000" } },
      taskState: baseTaskState,
      relation: "same_task_supplement",
      action: "append",
    });

    const result = prepareSupervisorMilestoneRuntimeRequest({ plan });
    expect(result).toEqual({
      ready: false,
      reason: "routine append, steer, continue, and defer flows should skip milestone emission",
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
      runtimeRequest: {
        kind: "supervisor_milestone",
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
    expect(buildSupervisorMilestoneOutcomePayload(result)).toEqual({
      reason: "routine append, steer, continue, and defer flows should skip milestone emission",
      prompt: {
        audience_question: "Did you absorb my new constraint or material?",
        semantic_role:
          "Only surface visible progress if the added material changes the work product.",
        prompt_hint:
          "Only narrate progress if the added detail materially changes the visible work.",
      },
      runtimeEnvelope: result.runtimeEnvelope,
      runtimeRequest: result.runtimeRequest,
    });
  });
});
