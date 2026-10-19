import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { t } from "../i18n/index.ts";
import type { SessionProgressCardRefreshState } from "../lib/session-progress-cards.ts";

export const REFRESH_STATUS_LABEL_KEYS: Record<
  SessionProgressCardRefreshState,
  Parameters<typeof t>[0]
> = {
  pending: "sessionProgressCard.refresh.pending",
  failed: "sessionProgressCard.refresh.failed",
  timeout: "sessionProgressCard.refresh.timeout",
  updated: "sessionProgressCard.refresh.updated",
};

export type SessionProgressCardRefreshAction = {
  state?: SessionProgressCardRefreshState;
  onRefresh: (card: ProgressCard) => void;
};

export type PresentedProgressStepStatus = ProgressCardStep["status"] | "paused";

export const STATUS_LABEL_KEYS: Record<ProgressCardStep["status"], Parameters<typeof t>[0]> = {
  completed: "sessionProgressCard.status.completed",
  in_progress: "sessionProgressCard.status.inProgress",
  pending: "sessionProgressCard.status.pending",
};

export const TERMINAL_RUN_OUTCOMES: Partial<
  Record<SessionRunStatus, "completed" | "failed" | "stopped">
> = {
  done: "completed",
  failed: "failed",
  killed: "stopped",
  timeout: "failed",
};

function progressCounts(card: ProgressCard): { completed: number; total: number } | null {
  const steps = card.steps;
  if (!steps?.length) {
    return null;
  }
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
  };
}

type ProgressCardHeadsUp = {
  completed: number;
  status: PresentedProgressStepStatus;
  step: string;
  total: number;
};

function unfinishedProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending")
  );
}

function isProgressCardStaleForRun(card: ProgressCard, startedAt?: number): boolean {
  const runStart = asDateTimestampMs(startedAt);
  const cardUpdate = asDateTimestampMs(card.updatedAt);
  return runStart !== undefined && cardUpdate !== undefined && cardUpdate < runStart;
}

export function progressCardHeadsUp(
  card: ProgressCard | null | undefined,
  sessionStatus?: SessionRunStatus,
  startedAt?: number,
  hasActiveRun = true,
): ProgressCardHeadsUp | null {
  const staleForRun = card ? isProgressCardStaleForRun(card, startedAt) : false;
  if (sessionStatus && TERMINAL_RUN_OUTCOMES[sessionStatus] && !staleForRun) {
    return null;
  }
  const counts = card ? progressCounts(card) : null;
  if (!counts || !card?.steps) {
    return null;
  }
  const step = unfinishedProgressStep(card.steps);
  if (!step) {
    return null;
  }
  const status =
    step.status === "in_progress" && (staleForRun || !hasActiveRun) ? "paused" : step.status;
  return { ...counts, status, step: step.step };
}

function currentProgressStep(steps: readonly ProgressCardStep[]): ProgressCardStep | undefined {
  return unfinishedProgressStep(steps) ?? steps.findLast((step) => step.status === "completed");
}

export function promoteFirstProgressBar(sanitizedHtml: string): string {
  const template = document.createElement("template");
  template.innerHTML = sanitizedHtml;
  const progress = template.content.querySelector("progress");
  if (!progress) {
    return sanitizedHtml;
  }
  const value = progress.getAttribute("value")?.trim();
  const max = progress.getAttribute("max")?.trim();
  const label =
    progress.getAttribute("aria-label")?.trim() ||
    (value && max
      ? `${t("sessionProgressCard.title")} · ${value}/${max}`
      : t("sessionProgressCard.title"));
  progress.setAttribute("aria-label", label);
  const originalParent = progress.parentElement;
  const wrapper = document.createElement("div");
  wrapper.className = "session-progress-card__progress";
  const visibleLabel = document.createElement("span");
  visibleLabel.className = "session-progress-card__progress-label";
  visibleLabel.textContent = label;
  wrapper.append(visibleLabel, progress);
  if (
    originalParent?.tagName === "P" &&
    originalParent.children.length === 0 &&
    !originalParent.textContent?.trim()
  ) {
    originalParent.remove();
  }
  // Reorder only the already-sanitized tree; generated copy uses textContent so
  // promoting a bar cannot reintroduce authored markup or event handlers.
  template.content.prepend(wrapper);
  return template.innerHTML;
}

export function progressCardPresentation(
  card: ProgressCard,
  sessionStatus?: SessionRunStatus,
  startedAt?: number,
  endedAt?: number,
  hasActiveRun = true,
) {
  const counts = progressCounts(card);
  const countLabel = counts
    ? t("sessionProgressCard.countLabel", {
        completed: String(counts.completed),
        total: String(counts.total),
      })
    : t("sessionProgressCard.noteLabel");
  const validStartedAt = asDateTimestampMs(startedAt);
  const validEndedAt = asDateTimestampMs(endedAt);
  const validUpdatedAt = asDateTimestampMs(card.updatedAt);
  const hasValidRunWindow =
    validStartedAt !== undefined &&
    validEndedAt !== undefined &&
    validEndedAt >= validStartedAt &&
    validUpdatedAt !== undefined &&
    validUpdatedAt >= validStartedAt &&
    validUpdatedAt <= validEndedAt;
  // A refreshed snapshot written after a run ended belongs to the new status
  // check, not that run’s old completion time or outcome.
  // A later run does not own durable progress last updated before it starts.
  // Queued runs can retain the previous run's timestamps, but do not own its progress.
  const hasCurrentRunActivity =
    hasActiveRun &&
    !isProgressCardStaleForRun(card, startedAt) &&
    (validUpdatedAt === undefined ||
      (sessionStatus !== "queued" &&
        (validStartedAt !== undefined || sessionStatus === undefined)));
  const terminalTimestamp =
    sessionStatus && TERMINAL_RUN_OUTCOMES[sessionStatus] && hasValidRunWindow
      ? validEndedAt
      : undefined;
  const effectiveSessionStatus =
    sessionStatus && TERMINAL_RUN_OUTCOMES[sessionStatus] && !terminalTimestamp
      ? undefined
      : sessionStatus;
  const activityTimestamp = terminalTimestamp ?? validUpdatedAt ?? Date.now();
  const activityKey = terminalTimestamp
    ? (`sessionProgressCard.activity.${TERMINAL_RUN_OUTCOMES[sessionStatus!]!}` as const)
    : "sessionProgressCard.activity.updated";
  const steps = card.steps ?? [];
  const currentStep = currentProgressStep(steps);
  const currentPosition = Math.max(1, currentStep ? steps.indexOf(currentStep) + 1 : 0);
  const complete = steps.length > 0 && steps.every((step) => step.status === "completed");
  const stepLabel = currentStep?.step ?? t("sessionProgressCard.noteLabel");
  const terminalOutcome = effectiveSessionStatus
    ? TERMINAL_RUN_OUTCOMES[effectiveSessionStatus]
    : undefined;
  const outcomeLabel = terminalOutcome ? t(`sessionProgressCard.outcome.${terminalOutcome}`) : null;
  const presentedCurrentStatus: PresentedProgressStepStatus | undefined =
    currentStep?.status === "in_progress" && !hasCurrentRunActivity && !terminalOutcome
      ? "paused"
      : currentStep?.status;
  return {
    counts,
    countLabel,
    hasCurrentRunActivity,
    effectiveSessionStatus,
    activityTimestamp,
    activityKey,
    currentStep,
    currentPosition,
    complete,
    stepLabel,
    terminalOutcome,
    outcomeLabel,
    presentedCurrentStatus,
  };
}
