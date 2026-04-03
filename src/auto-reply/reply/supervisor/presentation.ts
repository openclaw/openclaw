import type { ReplyPayload } from "../../types.js";
import type {
  SupervisorAction,
  SupervisorAdaptiveRuntimeProfile,
  SupervisorPresentationDelivery,
  SupervisorEvent,
  SupervisorPresentationLatencyClass,
  SupervisorPresentationPlan,
  SupervisorPresentationPlanItem,
  SupervisorPresentationRuntimeDisposition,
  SupervisorPresentationPlannedOutcomePayload,
  SupervisorPresentationSummary,
  SupervisorStatusScheduledOutcomePayload,
  SupervisorStatusSkippedOutcomePayload,
  SupervisorPresentationTemplateId,
  SupervisorRelation,
  SupervisorTaskState,
} from "./types.js";

type SupervisorStatusSemanticContract = {
  userQuestion: string;
  statusRole: string;
  milestoneRole: string;
  defaultTemplateId?: SupervisorPresentationTemplateId;
  milestoneEnabledByDefault?: boolean;
  milestonePromptHint?: string;
};

const STATUS_SEMANTIC_CONTRACTS: Partial<
  Record<SupervisorAction, SupervisorStatusSemanticContract>
> = {
  append: {
    userQuestion: "Did you absorb my new constraint or material?",
    statusRole: "Confirm that the new detail was folded into the current task.",
    milestoneRole: "Only surface visible progress if the added material changes the work product.",
    defaultTemplateId: "status.updating_current_task",
    milestoneEnabledByDefault: false,
    milestonePromptHint:
      "Only narrate progress if the added detail materially changes the visible work.",
  },
  steer: {
    userQuestion: "Did you actually change direction based on my correction?",
    statusRole: "Confirm that the current task direction was revised.",
    milestoneRole:
      "Only surface progress if the correction creates a meaningful reset or visible shift.",
    defaultTemplateId: "status.redirecting_current_task",
    milestoneEnabledByDefault: false,
    milestonePromptHint:
      "Only narrate progress if the correction caused a meaningful reset, narrowed scope, or visible shift.",
  },
  abort_and_replace: {
    userQuestion: "Did you drop the old task and switch focus?",
    statusRole: "Confirm that the new task now owns the foreground.",
    milestoneRole:
      "Only surface progress if the replacement task is long enough or yields a useful early result.",
    defaultTemplateId: "status.switching_to_new_task",
    milestoneEnabledByDefault: true,
    milestonePromptHint:
      "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
  },
  pause_and_fork: {
    userQuestion: "Did you preserve the current task while opening a side branch?",
    statusRole:
      "Confirm that the side task is foreground now but the current task remains resumable.",
    milestoneRole: "Surface progress only when the new branch reaches a meaningful checkpoint.",
    defaultTemplateId: "status.opening_side_task",
    milestoneEnabledByDefault: true,
    milestonePromptHint:
      "If a milestone is shown, make it clear that the side branch progressed while the original task stayed resumable.",
  },
  defer: {
    userQuestion: "Did you intentionally keep this for later instead of ignoring it?",
    statusRole: "Confirm that the event was captured without being foregrounded now.",
    milestoneRole:
      "Usually suppress; defer normally does not need intermediate progress narration.",
    defaultTemplateId: "status.defer_for_later",
    milestoneEnabledByDefault: false,
    milestonePromptHint:
      "Usually suppress defer milestones unless the defer state itself becomes materially useful context.",
  },
  continue: {
    userQuestion: "Did you keep the task going because I explicitly told you to?",
    statusRole: "Confirm that an explicit control signal kept the current task in place.",
    milestoneRole: "Usually suppress unless something else genuinely worth surfacing appears.",
    defaultTemplateId: "status.continuing",
    milestoneEnabledByDefault: false,
    milestonePromptHint:
      "Usually suppress milestones for continue; only surface independent progress worth showing.",
  },
};

function buildPlanItem(params: {
  kind: SupervisorPresentationPlanItem["kind"];
  enabled: boolean;
  latencyClass: SupervisorPresentationLatencyClass;
  mode: SupervisorPresentationPlanItem["mode"];
  templateId?: SupervisorPresentationTemplateId;
  reason: string;
  userQuestion?: string;
  semanticRole?: string;
  modelPromptHint?: string;
  modelInputDraft?: SupervisorPresentationPlanItem["modelInputDraft"];
}): SupervisorPresentationPlanItem {
  return {
    kind: params.kind,
    enabled: params.enabled,
    latencyClass: params.latencyClass,
    mode: params.mode,
    templateId: params.templateId,
    reason: params.reason,
    userQuestion: params.userQuestion,
    semanticRole: params.semanticRole,
    modelPromptHint: params.modelPromptHint,
    modelInputDraft: params.modelInputDraft,
  };
}

function shouldEmitAck(event: SupervisorEvent): boolean {
  if (event.category !== "user") {
    return false;
  }
  const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
  return text.length > 0;
}

function resolveStatusTemplate(params: {
  action: SupervisorAction;
  relation?: SupervisorRelation;
  taskState: SupervisorTaskState;
  runtimeDisposition?: SupervisorPresentationRuntimeDisposition;
}): { templateId: SupervisorPresentationTemplateId; reason: string } | undefined {
  const contract = STATUS_SEMANTIC_CONTRACTS[params.action];
  switch (params.action) {
    case "continue":
      if (params.taskState.phase === "idle" || params.relation === "unrelated") {
        return undefined;
      }
      if (params.relation !== "same_task_control") {
        return undefined;
      }
      return {
        templateId: contract?.defaultTemplateId ?? "status.continuing",
        reason: "explicit control-like input can use a deterministic continue status",
      };
    case "append":
      return {
        templateId: contract?.defaultTemplateId ?? "status.updating_current_task",
        reason: "same-task supplements should surface that the new constraint was absorbed",
      };
    case "steer":
      return {
        templateId: contract?.defaultTemplateId ?? "status.redirecting_current_task",
        reason: "same-task corrections should surface that the current direction was revised",
      };
    case "abort_and_replace":
      if (params.runtimeDisposition !== "preempting_active_run") {
        return undefined;
      }
      return {
        templateId: contract?.defaultTemplateId ?? "status.switching_to_new_task",
        reason: "only real runtime preemption should surface a replacement status immediately",
      };
    case "pause_and_fork":
      return {
        templateId: contract?.defaultTemplateId ?? "status.opening_side_task",
        reason: "parallel-task forks should explain the immediate runtime move",
      };
    case "defer":
      if (!params.taskState.isActive || params.taskState.phase === "waiting") {
        return undefined;
      }
      return {
        templateId: contract?.defaultTemplateId ?? "status.defer_for_later",
        reason:
          params.taskState.phase === "committing"
            ? "atomic phases should use a deterministic defer status"
            : "only foreground-preserving defer paths should surface a status",
      };
  }
}

function shouldEmitMilestone(params: {
  action: SupervisorAction;
  relation?: SupervisorRelation;
  event: SupervisorEvent;
  runtimeDisposition?: SupervisorPresentationRuntimeDisposition;
}): {
  enabled: boolean;
  reason: string;
  userQuestion?: string;
  semanticRole?: string;
  modelPromptHint?: string;
} {
  const contract = STATUS_SEMANTIC_CONTRACTS[params.action];
  if (params.event.category !== "user") {
    return {
      enabled: false,
      reason: "non-user events do not need consumer-facing milestones in the first increment",
      userQuestion: contract?.userQuestion,
      semanticRole: contract?.milestoneRole,
      modelPromptHint: contract?.milestonePromptHint,
    };
  }
  if (params.action === "pause_and_fork") {
    return {
      enabled: contract?.milestoneEnabledByDefault ?? true,
      reason:
        "parallel-task forks may need model-shaped wording to preserve conversational comfort",
      userQuestion: contract?.userQuestion,
      semanticRole: contract?.milestoneRole,
      modelPromptHint: contract?.milestonePromptHint,
    };
  }
  if (
    params.action === "abort_and_replace" &&
    params.relation === "new_task_replace" &&
    params.runtimeDisposition === "preempting_active_run"
  ) {
    return {
      enabled: contract?.milestoneEnabledByDefault ?? true,
      reason: "only confirmed runtime preemption should allow a replacement milestone",
      userQuestion: contract?.userQuestion,
      semanticRole: contract?.milestoneRole,
      modelPromptHint: contract?.milestonePromptHint,
    };
  }
  return {
    enabled: false,
    reason: "routine append, steer, continue, and defer flows should skip milestone emission",
    userQuestion: contract?.userQuestion,
    semanticRole: contract?.milestoneRole,
    modelPromptHint: contract?.milestonePromptHint,
  };
}

export function planSupervisorPresentation(params: {
  event: SupervisorEvent;
  taskState: SupervisorTaskState;
  action: SupervisorAction;
  relation?: SupervisorRelation;
  profile?: SupervisorAdaptiveRuntimeProfile;
  delivery?: SupervisorPresentationDelivery;
  runtimeDisposition?: SupervisorPresentationRuntimeDisposition;
}): SupervisorPresentationPlan {
  const profile = params.profile ?? "balanced";
  const delivery = params.delivery ?? "routable_external";
  const statusTemplate = resolveStatusTemplate({
    action: params.action,
    relation: params.relation,
    taskState: params.taskState,
    runtimeDisposition: params.runtimeDisposition,
  });
  const milestone = shouldEmitMilestone({
    action: params.action,
    relation: params.relation,
    event: params.event,
    runtimeDisposition: params.runtimeDisposition,
  });
  const contract = STATUS_SEMANTIC_CONTRACTS[params.action];

  return {
    profile,
    items: [
      buildPlanItem({
        kind: "ack",
        enabled: shouldEmitAck(params.event),
        latencyClass: "reflex",
        mode: shouldEmitAck(params.event) ? "template" : "none",
        templateId: shouldEmitAck(params.event) ? "ack.received" : undefined,
        reason: shouldEmitAck(params.event)
          ? "foreground user messages should receive a fast acknowledgement path"
          : "empty or non-user inputs do not need a dedicated ack payload",
        userQuestion: contract?.userQuestion,
      }),
      buildPlanItem({
        kind: "status",
        enabled: delivery === "routable_external" && Boolean(statusTemplate),
        latencyClass: "interactive",
        mode: delivery === "routable_external" && statusTemplate ? "template" : "none",
        templateId: delivery === "routable_external" ? statusTemplate?.templateId : undefined,
        reason:
          delivery !== "routable_external"
            ? "status is suppressed when the turn is not routable to an external channel"
            : (statusTemplate?.reason ?? "no intermediate status is needed for this path"),
        userQuestion: contract?.userQuestion,
        semanticRole: contract?.statusRole,
      }),
      buildPlanItem({
        kind: "milestone",
        enabled: milestone.enabled,
        latencyClass: "deliberative",
        mode: milestone.enabled ? "model" : "none",
        reason: milestone.reason,
        userQuestion: milestone.userQuestion,
        semanticRole: milestone.semanticRole,
        modelPromptHint: milestone.modelPromptHint,
        modelInputDraft:
          milestone.userQuestion && milestone.semanticRole && milestone.modelPromptHint
            ? {
                audience_question: milestone.userQuestion,
                semantic_role: milestone.semanticRole,
                prompt_hint: milestone.modelPromptHint,
                suppress_reason: milestone.enabled ? undefined : milestone.reason,
              }
            : undefined,
      }),
      buildPlanItem({
        kind: "final",
        enabled: true,
        latencyClass: "deliberative",
        mode: "model",
        reason: "final user-facing completion remains model-owned",
      }),
    ],
  };
}

export function renderSupervisorPresentationTemplate(
  templateId: SupervisorPresentationTemplateId,
): string {
  switch (templateId) {
    case "ack.received":
      return "收到了。";
    case "status.continuing":
      return "按你的要求继续当前任务。";
    case "status.updating_current_task":
      return "我会把你刚补充的信息并入当前任务。";
    case "status.redirecting_current_task":
      return "我会按你的修正调整当前任务方向。";
    case "status.switching_to_new_task":
      return "我现在切到这个新任务上。";
    case "status.opening_side_task":
      return "我先把这件事作为支线任务处理，当前任务会保留，稍后可以接着做。";
    case "status.defer_for_later":
      return "我先记下这件事，等当前任务处理完再接着看。";
  }
}

export function buildSupervisorStatusPayload(
  plan: SupervisorPresentationPlan,
): ReplyPayload | undefined {
  const statusItem = getSupervisorPresentationPlanItem(plan, "status");
  if (!statusItem?.enabled || statusItem.mode !== "template" || !statusItem.templateId) {
    return undefined;
  }
  return {
    text: renderSupervisorPresentationTemplate(statusItem.templateId),
  };
}

export function getSupervisorPresentationPlanItem(
  plan: SupervisorPresentationPlan,
  kind: SupervisorPresentationPlanItem["kind"],
): SupervisorPresentationPlanItem | undefined {
  return plan.items.find((item) => item.kind === kind);
}

export function getSupervisorMilestoneModelInputDraft(
  plan: SupervisorPresentationPlan,
): SupervisorPresentationPlanItem["modelInputDraft"] | undefined {
  return getSupervisorPresentationPlanItem(plan, "milestone")?.modelInputDraft;
}

export function buildSupervisorPresentationSummary(params: {
  plan: SupervisorPresentationPlan;
  statusScheduledForRuntime: boolean;
  milestoneScheduledForRuntime?: boolean;
}): SupervisorPresentationSummary {
  const statusItem = getSupervisorPresentationPlanItem(params.plan, "status");
  const milestoneItem = getSupervisorPresentationPlanItem(params.plan, "milestone");
  return {
    status: {
      planned: Boolean(statusItem?.enabled),
      scheduled_for_runtime: params.statusScheduledForRuntime,
      templateId: statusItem?.templateId,
      suppress_reason: statusItem?.enabled ? undefined : statusItem?.reason,
    },
    milestone: {
      planned: Boolean(milestoneItem?.enabled),
      eligible_for_runtime: milestoneItem?.enabled === true && milestoneItem?.mode === "model",
      scheduled_for_runtime: params.milestoneScheduledForRuntime === true,
      has_model_input_draft: Boolean(milestoneItem?.modelInputDraft),
      suppress_reason: milestoneItem?.enabled ? undefined : milestoneItem?.reason,
    },
  };
}

export function buildSupervisorPresentationPlannedOutcomePayload(
  summary: SupervisorPresentationSummary | undefined,
): SupervisorPresentationPlannedOutcomePayload {
  return {
    summary,
  };
}

export function buildSupervisorStatusOutcomePayload(params: {
  plan: SupervisorPresentationPlan;
  scheduledForRuntime: boolean;
}): SupervisorStatusScheduledOutcomePayload | SupervisorStatusSkippedOutcomePayload {
  const statusItem = getSupervisorPresentationPlanItem(params.plan, "status");
  if (params.scheduledForRuntime) {
    return {
      templateId: statusItem?.templateId,
    };
  }
  return {
    reason: statusItem?.reason,
  };
}
