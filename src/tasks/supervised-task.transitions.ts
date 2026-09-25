import type { SupervisedDecision, SupervisedTask } from "./supervised-task.types.js";

/** An episode endpoint is immutable. Input resumes as a new episode, never here. */
export function endSupervisedTask(
  task: SupervisedTask,
  endpoint: NonNullable<SupervisedTask["endpoint"]>,
): SupervisedTask {
  if (task.endpoint) {
    throw new Error("Supervised episode already ended");
  }
  return { ...task, phase: endpoint.kind, attempt: null, endpoint, updatedAt: endpoint.at };
}

export function expireSupervisedTask(task: SupervisedTask, now: number): SupervisedTask {
  const uncertain = task.attempt?.dispatched === true;
  return endSupervisedTask(task, {
    kind: uncertain ? "input_required" : "failed",
    reason: uncertain
      ? "Attempt stopped reporting; effects require reconciliation before retry"
      : "Supervised episode deadline or attempt budget exhausted",
    ...(uncertain
      ? {
          question: "Reconcile this attempt's effects, then explicitly resume or cancel this task.",
        }
      : {}),
    effects: uncertain ? "unknown" : "not_dispatched",
    evidence: [],
    acceptedBy: "supervisor",
    at: now,
  });
}

/** Validate the model's decision against the frozen goal; prose alone never completes a task. */
export function applySupervisedDecision(
  task: SupervisedTask,
  decision: SupervisedDecision,
  now: number,
): SupervisedTask {
  if (task.phase !== "running" || !task.attempt) {
    throw new Error("Decision requires a currently owned attempt");
  }
  if (decision.kind === "operation") {
    throw new Error("Operation decisions require atomic workflow admission");
  }
  if (now >= task.policy.deadlineAt || now >= task.attempt.expiresAt) {
    return expireSupervisedTask(task, now);
  }
  if (decision.kind === "define_goal") {
    if (task.goal) {
      throw new Error("An accepted goal cannot be replaced by the model");
    }
    if (decision.goal.partial.length) {
      throw new Error("Model goal inference cannot grant partial-success permission");
    }
    return {
      ...task,
      goal: decision.goal,
      goalSource: "model",
      phase: "ready",
      attempt: null,
      next: task.prompt,
      dueAt: now,
      updatedAt: now,
    };
  }
  if (!task.goal && decision.kind !== "input_required" && decision.kind !== "failed") {
    throw new Error("Define a structured goal before performing the task");
  }
  if (decision.kind === "continue" || decision.kind === "wait") {
    if (task.attempts >= task.policy.maxAttempts) {
      return endSupervisedTask(task, {
        kind: "failed",
        reason: "Attempt budget exhausted before goal completion",
        evidence: [],
        acceptedBy: "supervisor",
        effects: "attempt_completed",
        at: now,
      });
    }
    const dueAt = decision.kind === "wait" ? decision.wakeAt : now;
    if (dueAt < now || dueAt >= task.policy.deadlineAt) {
      throw new Error("Wait must resolve before the episode deadline");
    }
    return {
      ...task,
      phase: decision.kind === "wait" ? "waiting" : "ready",
      next: decision.next,
      dueAt,
      attempt: null,
      updatedAt: now,
    };
  }
  if (decision.kind === "succeeded" || decision.kind === "partial") {
    const goal = task.goal;
    if (!goal) {
      throw new Error("Missing accepted goal");
    }
    const required =
      decision.kind === "succeeded" ? goal.success.map((criterion) => criterion.id) : goal.partial;
    const evidenceIds = new Set(decision.evidence.map((entry) => entry.criterionId));
    if (
      !required.length ||
      evidenceIds.size !== decision.evidence.length ||
      required.some((key) => !evidenceIds.has(key)) ||
      decision.evidence.some(
        (entry) => !goal.success.some((criterion) => criterion.id === entry.criterionId),
      )
    ) {
      throw new Error(
        "Completion must provide evidence for the accepted success or partial criteria",
      );
    }
    return endSupervisedTask(task, {
      kind: decision.kind,
      reason: decision.summary,
      evidence: decision.evidence,
      acceptedBy: "model",
      effects: "attempt_completed",
      at: now,
    });
  }
  return endSupervisedTask(task, {
    kind: decision.kind,
    reason: decision.reason,
    ...(decision.kind === "input_required" ? { question: decision.question } : {}),
    evidence: [],
    acceptedBy: "model",
    effects: "attempt_completed",
    at: now,
  });
}
