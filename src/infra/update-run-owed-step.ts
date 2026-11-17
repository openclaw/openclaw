import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";

// A `finalize:` row survives step eviction in this codec and in published ones.
const OWED_STEP_PREFIX = "finalize:owed:";
// Compaction keeps an owed reason, so its size is bounded here instead.
const OWED_REASON_LIMIT = 500;

/** Follow-up work a successful update may leave for a later command. Add a step here to owe it. */
const UPDATE_OWED_STEPS = {
  "shell-completion": {
    label: "Shell completion refresh",
    retry: "Retried by the next `openclaw update`; run `openclaw update repair` to retry it now.",
  },
  "service-definition": {
    label: "Gateway service definition refresh",
    retry:
      "Settled when `openclaw update` next refreshes the service definition; `openclaw update repair` rechecks it.",
  },
  "plugin-convergence": {
    label: "Plugin convergence",
    retry: "Retried by the next `openclaw update`; run `openclaw update repair` to retry it now.",
  },
  "post-plugin-doctor": {
    label: "Post-plugin Doctor",
    retry:
      "Settled when `openclaw update` next completes Doctor after changing plugins; run `openclaw update repair` to retry it now.",
  },
} as const;

/** How many recent runs can still owe a step. */
export const UPDATE_OWED_STEP_HISTORY = 50;

export type UpdateOwedStepId = keyof typeof UPDATE_OWED_STEPS;
export type UpdateOwedStep = { id: string; runId: string; reason: string };

export function isUpdateOwedStepId(id: string): id is UpdateOwedStepId {
  return Object.hasOwn(UPDATE_OWED_STEPS, id);
}

export function isUpdateOwedStepRow(step: string): boolean {
  return step.startsWith(OWED_STEP_PREFIX);
}

/** A failed or rolled-back update did not keep its result, so it owes no follow-up. */
export function updateRunOwesSteps(run: Pick<UpdateRunRecord, "status">): boolean {
  return run.status !== "failed" && run.status !== "rolled-back";
}

/** `skipped` is owed and `completed` is settled, so no new step status is needed. */
export function updateOwedStepRow(id: string, reason?: string): UpdateRunStep {
  return {
    step: `${OWED_STEP_PREFIX}${id}`,
    status: reason === undefined ? "completed" : "skipped",
    endedAtMs: Date.now(),
    ...(reason === undefined ? {} : { detail: truncateUtf16Safe(reason, OWED_REASON_LIMIT) }),
  };
}

/** The steps one run recorded as owed and has not settled. */
export function listUpdateOwedSteps(run: {
  status: UpdateRunRecord["status"];
  steps: readonly UpdateRunStep[];
  runId?: string;
}): UpdateOwedStep[] {
  return updateRunOwesSteps(run)
    ? run.steps.flatMap((step) =>
        isUpdateOwedStepRow(step.step) && step.status === "skipped"
          ? [
              {
                id: step.step.slice(OWED_STEP_PREFIX.length),
                runId: run.runId ?? "",
                reason: step.detail ?? "no reason recorded",
              },
            ]
          : [],
      )
    : [];
}

/** What is owed now, from runs listed newest first: the newest run that mentions a step decides. */
export function selectUpdateOwedSteps(runs: readonly UpdateRunRecord[]): UpdateOwedStep[] {
  const decided = new Set<string>();
  return runs.flatMap((run) => {
    if (!updateRunOwesSteps(run)) {
      return [];
    }
    const undecided = run.steps.filter(
      (step) => isUpdateOwedStepRow(step.step) && !decided.has(step.step),
    );
    for (const step of undecided) {
      decided.add(step.step);
    }
    return listUpdateOwedSteps({ ...run, steps: undecided });
  });
}

/** One sentence for reports: what is owed, why, and what settles it. */
export function formatUpdateOwedStep(step: Pick<UpdateOwedStep, "id" | "reason">): string {
  const { label, retry } = isUpdateOwedStepId(step.id)
    ? UPDATE_OWED_STEPS[step.id]
    : { label: `Update step ${step.id}`, retry: "Update OpenClaw to a version that retries it." };
  return `${label} is owed: ${step.reason.replace(/[.\s]+$/u, "")}. ${retry}`;
}
