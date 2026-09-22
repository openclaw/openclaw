import { listAgentIds } from "../agents/agent-scope-config.js";
import { isUpdateDoctorLintPass } from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../infra/update-doctor-result.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import type { HealthFinding } from "./health-checks.js";

export type DoctorUpdateWork =
  | { kind: "startup" }
  | { kind: "inspection"; scope: "run" | "agent" }
  | { kind: "standalone" }
  | { kind: "finalize" };

export type DoctorUpdateBudget = {
  readonly agentCount: number;
  readonly inspectionDeadlineMs: number;
  readonly disposalDeadlineMs?: number;
  readonly phase: "validation" | "activation";
  readonly source: "validation-ledger" | "activation-policy" | "unavailable-validation-origin";
  readonly deferred: Map<string, HealthFinding>;
};

// Child Doctor receives no numeric parent deadline. Keep optional work within
// half the published 9.4 default validation window (300s, 2s cleanup).
// The ledger origin precedes the canary clock; newer parents may allow more.
// Activation uses a fresh optional-work window, not the expired canary clock.
const PUBLISHED_VALIDATION_WORK_MS = 298_000;
const INSPECTION_WINDOW_MS = PUBLISHED_VALIDATION_WORK_MS / 2;
// The measured 480-agent Doctor took 579s. Require two seconds per agent
// before admitting a fleet inspection; this is admission, never a kill timer.
const AGENT_INSPECTION_ALLOWANCE_MS = 2_000;
const RUN_INSPECTION_ALLOWANCE_MS = 5_000;

/** Read only the selected profile's existing ledger; these facts grant no write authority. */
export async function resolveDoctorUpdateBudget(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preparedAgentCount?: number;
}): Promise<DoctorUpdateBudget | undefined> {
  const rehearsal = resolveUpdateRehearsalRoot(params.env);
  const recordedUpdateDoctor =
    isUpdateDoctorLintPass(params.env) &&
    Boolean(params.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim());
  if (!rehearsal && !recordedUpdateDoctor) {
    return undefined;
  }
  const { listUpdateRunsAsync } = await import("../infra/update-run-reader.js");
  let validationStartedAt: number | undefined;
  try {
    const runs = await listUpdateRunsAsync({ active: true, limit: 2 }, { env: params.env });
    const run = runs.length === 1 ? runs[0] : undefined;
    validationStartedAt = run?.steps.find(
      (step) => step.step === "validating" && step.startedAtMs !== undefined,
    )?.startedAtMs;
  } catch {
    // Required schema/admission checks own unreadable state. Optional work
    // cannot consume an unknown old parent's remaining validation window.
  }
  if (!rehearsal && validationStartedAt === undefined) {
    return undefined;
  }
  return {
    agentCount: Math.max(listAgentIds(params.cfg).length, params.preparedAgentCount ?? 0),
    phase: rehearsal ? "validation" : "activation",
    ...(rehearsal && validationStartedAt !== undefined
      ? { disposalDeadlineMs: validationStartedAt + PUBLISHED_VALIDATION_WORK_MS }
      : {}),
    inspectionDeadlineMs: rehearsal
      ? validationStartedAt === undefined
        ? Date.now()
        : validationStartedAt + INSPECTION_WINDOW_MS
      : Date.now() + INSPECTION_WINDOW_MS,
    source: !rehearsal
      ? "activation-policy"
      : validationStartedAt === undefined
        ? "unavailable-validation-origin"
        : "validation-ledger",
    deferred: new Map(),
  };
}

export function admitDoctorUpdateInspection(
  budget: DoctorUpdateBudget | undefined,
  scope: "run" | "agent",
  checks: readonly { id: string; label: string }[],
): boolean {
  if (!budget) {
    return true;
  }
  const allowance =
    scope === "agent"
      ? Math.max(1, budget.agentCount) * AGENT_INSPECTION_ALLOWANCE_MS
      : RUN_INSPECTION_ALLOWANCE_MS;
  if (
    Date.now() + allowance <= budget.inspectionDeadlineMs &&
    checks.every((check) => !budget.deferred.has(check.id))
  ) {
    return true;
  }
  for (const check of checks) {
    if (budget.deferred.has(check.id)) {
      continue;
    }
    budget.deferred.set(check.id, {
      checkId: check.id,
      source: "doctor",
      severity: "warning",
      errorCode: "update-inspection-deferred",
      requirement: "update-validation-budget",
      message: `${check.label} deferred until after activation: ${budget.agentCount} agent scopes need a ${allowance}ms inspection allowance, with ${Math.max(0, budget.inspectionDeadlineMs - Date.now())}ms remaining in the ${budget.phase} inspection window (${budget.source}).`,
      fixHint:
        "Run `openclaw doctor --fix` after activation to complete deferred checks and repairs.",
    });
  }
  return false;
}
