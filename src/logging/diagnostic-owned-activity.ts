import type { DiagnosticEmbeddedRunOwner } from "../infra/diagnostic-model-request-provenance.js";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "./diagnostic-run-activity-snapshot.js";
import {
  activeDiagnosticOwners,
  touchSessionActivity,
  type DiagnosticBackendActivity,
  type DiagnosticOwnerRegistration,
} from "./diagnostic-run-activity-state.js";

export function resolveCurrentDiagnosticOwner(
  owner: DiagnosticEmbeddedRunOwner,
  assertCurrent?: () => void,
): DiagnosticOwnerRegistration | undefined {
  const registration = activeDiagnosticOwners.get(owner.generation);
  if (registration?.owner !== owner) {
    return undefined;
  }
  try {
    assertCurrent?.();
  } catch {
    return undefined;
  }
  // The caller assertion may synchronously retire or replace the registration.
  return activeDiagnosticOwners.get(owner.generation) === registration &&
    registration.activity.activeEmbeddedRuns.get(owner.workKey)?.generation === owner.generation
    ? registration
    : undefined;
}

/** Retains a provider wait only while its logical run still owns this attempt. */
export function beginDiagnosticRetryWait(params: {
  owner: DiagnosticEmbeddedRunOwner;
  deadlineAtMs: number;
  signal: AbortSignal;
  assertCurrent: () => void;
}): (completed?: boolean) => boolean {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const registration = resolveCurrentDiagnosticOwner(params.owner, assertCurrent);
  if (!registration) {
    return () => false;
  }
  registration.retryWait?.close();
  const close = (completed = false) => {
    const resumed =
      completed &&
      registration.retryWait === wait &&
      resolveCurrentDiagnosticOwner(params.owner, assertCurrent) === registration;
    if (registration.retryWait === wait) {
      registration.retryWait = undefined;
    }
    params.signal.removeEventListener("abort", onAbort);
    if (resumed) {
      touchSessionActivity(registration.activity, "retry_wait:ended");
    }
    return resumed;
  };
  const onAbort = () => {
    close();
  };
  const wait = { deadlineAtMs: params.deadlineAtMs, assertCurrent, close };
  registration.retryWait = wait;
  params.signal.addEventListener("abort", onAbort, { once: true });
  return close;
}

/** Binds one backend attempt's quiet allowance to its exact live core owner. */
export function beginDiagnosticBackendActivity(params: {
  owner: DiagnosticEmbeddedRunOwner;
  noOutputTimeoutMs: number;
  assertCurrent: () => void;
}): {
  observeOutput: (modelProgress: boolean) => boolean;
  setOutstandingWork: (active: boolean) => void;
  close: () => void;
} {
  const { owner, noOutputTimeoutMs, assertCurrent } = params;
  let quietAllowanceMs = noOutputTimeoutMs;
  const registration = resolveCurrentDiagnosticOwner(owner, assertCurrent);
  const backendActivity: DiagnosticBackendActivity = {
    deadlineAtMs: Date.now() + noOutputTimeoutMs,
    assertCurrent,
  };
  if (registration) {
    registration.backendActivity = backendActivity;
  }
  const currentActivity = () => {
    const current = resolveCurrentDiagnosticOwner(owner, assertCurrent);
    return current?.backendActivity === backendActivity ? current.activity : undefined;
  };
  return {
    observeOutput: (modelProgress) => {
      const activity = currentActivity();
      if (!activity) {
        return false;
      }
      const now = Date.now();
      backendActivity.deadlineAtMs = now + quietAllowanceMs;
      if (!modelProgress || activity.activeTools.size > 0) {
        return false;
      }
      touchSessionActivity(activity, "model_call:stream_progress", now);
      return true;
    },
    setOutstandingWork: (active) => {
      if (!currentActivity()) {
        return;
      }
      const allowanceMs = active
        ? Math.max(noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
        : noOutputTimeoutMs;
      // Work-state changes preserve the last output's origin, not a new progress clock.
      backendActivity.deadlineAtMs += allowanceMs - quietAllowanceMs;
      quietAllowanceMs = allowanceMs;
    },
    close: () => {
      // Compare-release remains valid after abort and cannot retire a later attempt.
      const current = activeDiagnosticOwners.get(owner.generation);
      if (current?.owner === owner && current.backendActivity === backendActivity) {
        delete current.backendActivity;
      }
    },
  };
}
