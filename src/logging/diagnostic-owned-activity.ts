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
  if (
    registration?.owner !== owner ||
    registration.activity.activeEmbeddedRuns.get(owner.workKey)?.generation !== owner.generation
  ) {
    return undefined;
  }
  try {
    assertCurrent?.();
  } catch {
    return undefined;
  }
  return registration;
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
  const ownedWait = params.owner.watchdogAttempt?.beginWait({
    kind: "retry",
    deadlineAtMs: params.deadlineAtMs,
    isCurrent: () => {
      assertCurrent();
      return true;
    },
  });
  const registration = resolveCurrentDiagnosticOwner(params.owner, assertCurrent);
  if (!registration) {
    if (ownedWait) {
      return (completed = false) => {
        ownedWait.close();
        if (!completed) {
          return false;
        }
        try {
          assertCurrent();
          return params.owner.watchdogAttempt!.isCurrent();
        } catch {
          return false;
        }
      };
    }
    return () => false;
  }
  registration.retryWait?.close();
  const close = (completed = false) => {
    ownedWait?.close();
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

const FOREGROUND_AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

/** Binds one backend attempt's quiet allowance to its exact live core owner. */
export function beginDiagnosticBackendActivity(params: {
  owner: DiagnosticEmbeddedRunOwner;
  noOutputTimeoutMs: number;
  assertCurrent: () => void;
}) {
  const { owner, noOutputTimeoutMs, assertCurrent } = params;
  const attempt = owner.watchdogAttempt;
  let closed = false;
  const ownsAttempt = () => {
    if (closed || !attempt?.isCurrent()) {
      return false;
    }
    try {
      assertCurrent();
    } catch {
      return false;
    }
    return !closed && attempt.isCurrent();
  };
  const ownedWait = attempt?.beginWait({
    kind: "backend",
    deadlineAtMs: Date.now() + noOutputTimeoutMs,
    isCurrent: () => {
      assertCurrent();
      return true;
    },
  });
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
    observeOutput: (modelProgress: boolean) => {
      if (closed || (attempt && !ownsAttempt())) {
        return false;
      }
      const activity = currentActivity();
      if (closed || (attempt && !ownsAttempt())) {
        return false;
      }
      const now = Date.now();
      backendActivity.deadlineAtMs = now + quietAllowanceMs;
      ownedWait?.updateDeadline(backendActivity.deadlineAtMs);
      const progressed = modelProgress
        ? (attempt?.progressModel("model_call:stream_progress") ?? false)
        : (attempt?.progress("transport", "model_call:stream_progress") ?? false);
      if (!activity) {
        return progressed;
      }
      if (!modelProgress || activity.activeTools.size > 0) {
        return false;
      }
      touchSessionActivity(activity, "model_call:stream_progress", now);
      return true;
    },
    observeAttributedAgentProgress: (parentToolCallId: string) => {
      if (closed || (attempt && !ownsAttempt())) {
        return false;
      }
      const toolCallId = parentToolCallId.trim();
      const ownedProgress = attempt?.progressTool(toolCallId, ["Agent", "Task"]) ?? false;
      const activity = currentActivity();
      const tool = toolCallId
        ? [...(activity?.activeTools.values() ?? [])].find(
            (active) =>
              active.toolCallId === toolCallId && FOREGROUND_AGENT_TOOL_NAMES.has(active.toolName),
          )
        : undefined;
      if (attempt ? !ownedProgress : !tool) {
        return false;
      }
      const now = Date.now();
      backendActivity.deadlineAtMs = now + quietAllowanceMs;
      ownedWait?.updateDeadline(backendActivity.deadlineAtMs);
      if (activity && tool) {
        touchSessionActivity(activity, `tool:${tool.toolName}:subagent_progress`, now);
      }
      return true;
    },
    setOutstandingWork: (active: boolean) => {
      if (closed || (attempt ? !ownsAttempt() : !currentActivity())) {
        return;
      }
      const allowanceMs = active
        ? Math.max(noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
        : noOutputTimeoutMs;
      // Work-state changes preserve the last output's origin, not a new progress clock.
      backendActivity.deadlineAtMs += allowanceMs - quietAllowanceMs;
      quietAllowanceMs = allowanceMs;
      ownedWait?.updateDeadline(backendActivity.deadlineAtMs);
    },
    close: () => {
      closed = true;
      ownedWait?.close();
      // Compare-release remains valid after abort and cannot retire a later attempt.
      const current = activeDiagnosticOwners.get(owner.generation);
      if (current?.owner === owner && current.backendActivity === backendActivity) {
        delete current.backendActivity;
      }
    },
  };
}
