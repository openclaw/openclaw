import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";
import { recordDiagnosticsTimelineDuration } from "../../infra/diagnostics-timeline.js";
import type { ProvisionCopyDetails } from "../../infra/fs-safe-copy-worker-contract.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SpawnResult } from "../../process/exec-result.js";
import type { LocalWorkspacePausePhase } from "../sandbox/types.js";

type PreparationPhase =
  | `reuse.${LocalWorkspacePausePhase | "probeCanonical" | "probeProjection" | "capturePreparation"}`
  | "allocate"
  | "allocationWait"
  | "mutationWait"
  | "workspaceWait"
  | "capacityWait"
  | "repository"
  | "sources"
  | "sourceRelease"
  | "leaseRelease"
  | "reservation"
  | "base"
  | "baseRefresh"
  | "baseHydration"
  | "baseFastForward"
  | "baseWait"
  | "diskAdmission"
  | "registration"
  | "registrationInspect"
  | "registrationMetadata"
  | "commitPrepare"
  | "cloneEstimate"
  | "indexLocate"
  | "checkoutDestination"
  | "checkoutMarker"
  | "promptReady"
  | "warmPoolTake"
  | "warmPoolApply"
  | "templateRelease"
  | "provision"
  | "provisionEstimate"
  | "provisionInspect"
  | "provisionCopy"
  | "provisionCopyWait"
  | "publication"
  | "indexRefresh"
  | "indexCopy"
  | "indexCloneWait"
  | "indexMetadata"
  | "checkout"
  | "setup"
  | "templatePrepare"
  | "templateRetire"
  | "templateValidate"
  | "templateClone"
  | "templateValidateOutput"
  | "templateApply"
  | "snapshot"
  | "synchronizeCanonical"
  | "synchronizeProjection"
  | "runtimeQuiesce"
  | "runtimeResume"
  | "containerStart"
  | "workspaceLayout";
type TemplateState = "warm" | "cold" | "unavailable" | "reused";
type TemplateDetails = {
  identity?: string;
  reason?: string;
  missReason?:
    | "no-generation"
    | "commit-changed"
    | "backend-changed"
    | "content-changed"
    | "invalid";
  priorSourceCommit?: string;
  requestedSourceCommit?: string;
  refreshRejectReason?:
    | "template-missing"
    | "validation-failed"
    | "attributes-changed"
    | "checkout-policy-mismatch"
    | "diff-probe-failed";
  validationFailure?:
    | "checkout-policy"
    | "status-probe"
    | "status-malformed"
    | "dirty"
    | "head-mismatch";
  refreshErrorClass?:
    | "exit-nonzero"
    | "timeout"
    | "no-output-timeout"
    | "signal"
    | "output-truncated";
  backend?: string;
  cloneBytes?: number;
  nativeCloneCount?: number;
  nativeCloneWriteBytes?: number;
  nativeCloneUnmeasuredCount?: number;
  errorCode?: string;
};
type PreparationTimingState = {
  enabled: boolean;
  template: TemplateState;
  templateDetails: TemplateDetails;
  copyDetails?: ProvisionCopyDetails;
  phases: Partial<Record<PreparationPhase, number>>;
  activePhases: number;
  coveredSince: number;
  coveredMs: number;
  failure?: { error: unknown; phase: PreparationPhase };
};
const log = createSubsystemLogger("agents/worktrees");
const preparation = new AsyncLocalStorage<PreparationTimingState>();

export function markManagedWorktreePreparation() {
  const current = preparation.getStore();
  if (current) {
    current.enabled = true;
  }
}

export function setWorktreePreparationTemplate(
  template: TemplateState | undefined,
  details?: TemplateDetails,
) {
  const current = preparation.getStore();
  if (current) {
    if (template) {
      current.template = template;
    }
    Object.assign(current.templateDetails, details);
  }
}

export function recordWorktreePreparationFailure(phase: PreparationPhase, error: unknown) {
  const current = preparation.getStore();
  // Preserve the innermost failing phase as the error crosses enclosing waits.
  if (
    current &&
    (!current.failure || !collectNestedErrorCandidates(error).includes(current.failure.error))
  ) {
    current.failure = { error, phase };
  }
}

/** Record only the completed probe's bounded outcome, never its repository output. */
export function recordWorktreeTemplateProbeFailure(
  reason: "validation-failed" | "diff-probe-failed",
  result: Pick<SpawnResult, "termination" | "code" | "stdoutTruncatedBytes">,
) {
  setWorktreePreparationTemplate(undefined, {
    refreshRejectReason: reason,
    validationFailure: reason === "validation-failed" ? "status-probe" : undefined,
    refreshErrorClass:
      result.termination !== "exit"
        ? result.termination
        : result.code !== 0
          ? "exit-nonzero"
          : "output-truncated",
  });
}

export function setWorktreePreparationCopyDetails(details: ProvisionCopyDetails) {
  const current = preparation.getStore();
  if (current) {
    current.copyDetails = details;
  }
}

export function recordWorktreeNativeClone(writeBytes: number | undefined) {
  const details = preparation.getStore()?.templateDetails;
  if (details) {
    details.nativeCloneCount = (details.nativeCloneCount ?? 0) + 1;
    if (writeBytes === undefined) {
      details.nativeCloneUnmeasuredCount = (details.nativeCloneUnmeasuredCount ?? 0) + 1;
    } else {
      details.nativeCloneWriteBytes = (details.nativeCloneWriteBytes ?? 0) + writeBytes;
    }
  }
}

/** Nested phases are inclusive; only total measures the complete preparation once. */
export function startWorktreePreparationPhase(phase: PreparationPhase) {
  const current = preparation.getStore();
  const startedAt = performance.now();
  if (current && current.activePhases++ === 0) {
    current.coveredSince = startedAt;
  }
  let finished = false;
  return () => {
    if (current && !finished) {
      const now = performance.now();
      current.phases[phase] = (current.phases[phase] ?? 0) + now - startedAt;
      if (--current.activePhases === 0) {
        current.coveredMs += now - current.coveredSince;
      }
      finished = true;
    }
  };
}

export async function timeWorktreePreparationPhase<T>(
  phase: PreparationPhase,
  run: () => Promise<T>,
): Promise<T> {
  const finish = startWorktreePreparationPhase(phase);
  try {
    return await run();
  } catch (error) {
    recordWorktreePreparationFailure(phase, error);
    throw error;
  } finally {
    finish();
  }
}

export async function withWorktreePreparationTiming<T>(
  kind: "managed" | "managed-prewarm" | "sandbox",
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const start = performance.now();
  const emit = createQueuedDiagnosticPhaseEmitter();
  const current: PreparationTimingState = {
    enabled: kind !== "sandbox",
    template: "unavailable",
    templateDetails: { reason: "not-requested" },
    phases: {},
    activePhases: 0,
    coveredSince: 0,
    coveredMs: 0,
  };
  let outcome = "threw";
  let failure: unknown;
  try {
    const result = await preparation.run(current, run);
    outcome = "returned";
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (current.enabled) {
      try {
        const errorDetails: Record<string, string> =
          outcome === "threw"
            ? {
                errorClass: failure instanceof Error ? failure.name : typeof failure,
                errorPhase:
                  current.failure &&
                  collectNestedErrorCandidates(failure).includes(current.failure.error)
                    ? current.failure.phase
                    : "unattributed",
              }
            : {};
        const end = performance.now();
        const durationMs = Math.round(end - start);
        const coveredMs =
          current.coveredMs + (current.activePhases ? end - current.coveredSince : 0);
        const unattributedMs = Math.round(Math.max(0, end - start - coveredMs));
        const phaseDurationsMs = Object.fromEntries(
          Object.entries(current.phases).map(([phase, duration]) => [phase, Math.round(duration)]),
        );
        const reuseDominantPhase = Object.entries(current.phases)
          .filter(([phase]) => phase.startsWith("reuse."))
          .toSorted((a, b) => b[1] - a[1])[0]?.[0];
        recordDiagnosticsTimelineDuration(`worktree.${kind}`, end - start);
        for (const [phase, duration] of Object.entries(current.phases)) {
          recordDiagnosticsTimelineDuration(`worktree.${kind}.${phase}`, duration);
        }
        recordDiagnosticsTimelineDuration(
          `worktree.${kind}.unattributed`,
          Math.max(0, end - start - coveredMs),
        );
        log.info("managed worktree preparation", {
          consoleMessage: `managed worktree preparation kind=${kind} template=${current.template} templateDetails=${JSON.stringify(current.templateDetails)} copyDetails=${JSON.stringify(current.copyDetails ?? {})} outcome=${outcome} errorDetails=${JSON.stringify(errorDetails)} durationMs=${durationMs} unattributedMs=${unattributedMs} reuseDominantPhase=${reuseDominantPhase ?? "none"} phaseDurationsMs=${JSON.stringify(phaseDurationsMs)}`,
          kind,
          template: current.template,
          templateDetails: current.templateDetails,
          copyDetails: current.copyDetails,
          outcome,
          ...errorDetails,
          durationMs,
          unattributedMs,
          phaseDurationsMs,
          reuseDominantPhase,
        });
        emit?.({
          name: "worktree.preparation",
          startedAt,
          endedAt: Date.now(),
          durationMs,
          details: {
            kind,
            template: current.template,
            ...Object.fromEntries(
              Object.entries(current.templateDetails).map(([key, value]) => [
                `template.${key}`,
                value,
              ]),
            ),
            outcome,
            ...Object.fromEntries(
              Object.entries(current.copyDetails ?? {}).map(([key, value]) => [
                `copy.${key}`,
                value,
              ]),
            ),
            ...errorDetails,
            ...(reuseDominantPhase ? { reuseDominantPhase } : {}),
            unattributedMs,
            ...phaseDurationsMs,
          },
        });
      } catch {
        // Telemetry must preserve the preparation's result or original failure.
      }
    }
  }
}
