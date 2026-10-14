import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { logDebug } from "../logger.js";
import {
  redactSupportDiagnosticLine,
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { formatErrorMessageWithCode, toErrorObject } from "./errors.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyUrl,
} from "./net/proxy/active-proxy-state.js";
import { registerManagedProxyGatewayLoopbackBypass } from "./net/proxy/proxy-lifecycle.js";
import {
  isUpdateCanaryStartupMilestone,
  UPDATE_CANARY_PROGRESS_PREFIX,
  type UpdateCanaryStartupMilestone,
  type UpdateCanaryStartupProgress,
} from "./update-candidate-canary-progress.js";
import { createUpdateFailureFact, type UpdateFailureFact } from "./update-failure-facts.js";

export function observeUpdateCandidateStartup(params: SupportRedactionContext) {
  const milestones = new Map<UpdateCanaryStartupMilestone, number>();
  return {
    milestones,
    onLine: (line: string) => {
      if (!line.startsWith(UPDATE_CANARY_PROGRESS_PREFIX)) {
        return;
      }
      const milestone = line.slice(UPDATE_CANARY_PROGRESS_PREFIX.length);
      if (!isUpdateCanaryStartupMilestone(milestone)) {
        logDebug(
          redactSupportString(
            `Ignoring unknown candidate startup milestone: ${JSON.stringify(milestone)}`,
            params,
          ),
        );
      } else if (!milestones.has(milestone)) {
        milestones.set(milestone, Date.now());
      }
    },
  };
}

/** Poll candidate control-plane endpoints under the existing managed loopback policy. */
export async function waitForUpdateCandidateReadiness(
  params: SupportRedactionContext & {
    port: number;
    workDeadline: number;
    started: number;
    signal?: AbortSignal;
    processExitSignal: AbortSignal;
    assertCurrent?: () => void;
    hasExited: () => boolean;
    getExitReason: () => string | undefined;
    startupProgress: UpdateCanaryStartupProgress;
    onWarning: (message: string) => void | Promise<void>;
    onEndpoint: (endpoint: "startupz" | "readyz") => void;
    capture: (message: string) => void;
  },
): Promise<{ fact: UpdateFailureFact; message: string } | undefined> {
  const deadline = new AbortController();
  const waitStarted = Date.now();
  const stallBudgetMs = Math.max(1, params.workDeadline - waitStarted);
  // Progress buys time on slow hardware, but cannot keep a broken candidate alive forever.
  const hardDeadline = waitStarted + 4 * stallBudgetMs;
  let workDeadline = params.workDeadline;
  const milestones = new Set<string>();
  let lastProgress: { milestone: string; completedAt: number } | undefined;
  let deadlineFailure: Error | undefined;
  let warned = false;
  // No warning means no async work to fence; each check may snapshot shared state.
  let warningPending: Promise<void> | undefined;
  const recordProgress = (milestone: string, completedAt: number) => {
    if (milestones.has(milestone)) {
      return;
    }
    milestones.add(milestone);
    if (!lastProgress || completedAt >= lastProgress.completedAt) {
      lastProgress = { milestone, completedAt };
      workDeadline = Math.min(hardDeadline, Math.max(workDeadline, completedAt + stallBudgetMs));
    }
  };
  const refreshDeadline = () => {
    if (deadline.signal.aborted) {
      return;
    }
    for (const [milestone, completedAt] of params.startupProgress) {
      recordProgress(milestone, completedAt);
    }
    if (!warned && Date.now() >= params.workDeadline && Date.now() < workDeadline) {
      warned = true;
      warningPending = Promise.resolve(
        params.onWarning(
          `Candidate Gateway startup is still progressing after ${Date.now() - params.started}ms; continuing to wait while startup milestones advance.`,
        ),
      ).catch((error: unknown) => {
        deadlineFailure = toErrorObject(error, "Candidate startup warning could not be recorded");
        deadline.abort();
      });
    }
  };
  let cancelDeadline = () => {};
  const checkDeadline = () => {
    try {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      refreshDeadline();
      if (Date.now() >= workDeadline) {
        deadline.abort();
      } else {
        cancelDeadline = scheduleAbsoluteDeadline(workDeadline, checkDeadline);
      }
    } catch (error) {
      deadlineFailure ??= toErrorObject(error, "Candidate startup wait failed");
      deadline.abort();
    }
  };
  cancelDeadline = scheduleAbsoluteDeadline(workDeadline, checkDeadline);
  const signal = AbortSignal.any([
    deadline.signal,
    params.processExitSignal,
    ...(params.signal ? [params.signal] : []),
  ]);
  const assertRunning = () => {
    if (deadlineFailure !== undefined) {
      throw deadlineFailure;
    }
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    if (params.hasExited()) {
      throw new Error(params.getExitReason() ?? "The updated Gateway exited before it was ready");
    }
    if (Date.now() >= hardDeadline) {
      throw new Error(
        `Candidate still starting after ${(Date.now() - waitStarted) / 1_000} s; milestones reached: ${[...milestones].join(", ") || "none"}`,
      );
    }
  };
  let probeFailure: { fact: UpdateFailureFact; message: string } | undefined;
  let operationFailure: Error | undefined;
  try {
    endpoints: for (const endpoint of ["startupz", "readyz"] as const) {
      params.onEndpoint(endpoint);
      const url = `http://127.0.0.1:${params.port}/${endpoint}`;
      const releaseBypass = registerManagedProxyGatewayLoopbackBypass(url);
      const proxy =
        getActiveManagedProxyLoopbackMode() === "proxy" ? getActiveManagedProxyUrl() : undefined;
      let failure: { fact: UpdateFailureFact; message: string } | undefined;
      let candidatePending = false;
      try {
        while (true) {
          assertRunning();
          refreshDeadline();
          if (warningPending) {
            await warningPending;
            assertRunning();
          }
          if (Date.now() >= workDeadline) {
            if (lastProgress && (candidatePending || !proxy)) {
              throw new Error(
                `Candidate Gateway startup stalled for ${stallBudgetMs}ms after ${lastProgress.milestone}`,
              );
            }
            if (!failure) {
              throw new Error("Update validation deadline exceeded");
            }
            params.capture(failure.message);
            probeFailure = failure;
            break endpoints;
          }
          let outcome = "";
          let ready = false;
          try {
            const response = await fetch(url, { signal });
            outcome = `HTTP ${response.status}`;
            if (response.status === 200 || response.status === 503) {
              const payload: unknown = await response.json();
              ready =
                response.status === 200 &&
                (endpoint === "readyz" || (isRecord(payload) && payload.status === "started"));
              candidatePending =
                isRecord(payload) &&
                (endpoint === "startupz" ? payload.status === "starting" : payload.ready === false);
              outcome += " (startup response not ready within the validation budget)";
            } else {
              candidatePending = false;
              await response.body?.cancel();
            }
          } catch (error) {
            if (!deadline.signal.aborted) {
              candidatePending = false;
            }
            outcome = `${outcome ? `${outcome}: ` : ""}${formatErrorMessageWithCode(error)}`;
          }
          assertRunning();
          refreshDeadline();
          if (warningPending) {
            await warningPending;
            assertRunning();
          }
          if (ready && Date.now() < workDeadline) {
            params.capture(
              `${endpoint}: ${endpoint === "startupz" ? "started" : "ready"} (${Date.now() - params.started}ms)`,
            );
            // A probe proves startup, but only producer milestones renew its allowance.
            lastProgress = { milestone: endpoint, completedAt: Date.now() };
            break;
          }
          // Keep the last observed cause when the common deadline aborts a later poll.
          if (!deadline.signal.aborted || !failure) {
            const detail = redactSupportDiagnosticLine(outcome, params);
            const nextStep = "Check Gateway logs and proxy.loopbackMode; rerun openclaw update.";
            failure = {
              message: redactSupportString(
                `Readiness check ${url} failed: ${detail}${proxy ? ` (via proxy ${proxy.origin})` : ""}. ${nextStep}`,
                params,
              ),
              fact: createUpdateFailureFact(
                {
                  check: endpoint,
                  code: "candidate-readiness-probe-failed",
                  message: `Readiness check ${endpoint} failed: ${detail}. ${nextStep}`,
                },
                params.env,
              ),
            };
          }
          if (Date.now() >= workDeadline) {
            continue;
          }
          await sleep(Math.min(100, workDeadline - Date.now()), undefined, {
            signal: params.signal,
          });
        }
      } finally {
        releaseBypass?.();
      }
    }
  } catch (error) {
    operationFailure = toErrorObject(error, "Candidate startup wait failed");
  } finally {
    cancelDeadline();
    await warningPending;
  }
  if (deadlineFailure && hasCommandProcessCleanupError(deadlineFailure)) {
    if (operationFailure && operationFailure !== deadlineFailure) {
      throw new AggregateError(
        [operationFailure, deadlineFailure],
        "Candidate readiness and warning recording failed",
        { cause: operationFailure },
      );
    }
    throw deadlineFailure;
  }
  if (operationFailure) {
    throw operationFailure;
  }
  return probeFailure;
}
