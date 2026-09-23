import type { PreparedCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { currentUpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { resolveStartupInstallStatus } from "../../infra/update-install-status.js";
import { cancelManagedServiceUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import {
  finishUpdateRun,
  recordUpdateRunDiagnostics,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { summarizeUpdateStepFailure, type UpdateRunRecord } from "../../infra/update-run-record.js";
import { resolveUpdateInstallSurface } from "../../infra/update-runner-install-surface.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";

export function retainUpdateRequesterAuthority(
  requester: UpdateRequester | undefined,
  authority: PreparedCommandOwnerAuthority | undefined,
  getConfig: () => OpenClawConfig,
) {
  return {
    signal: authority?.signal,
    assertCurrent: () => {
      if (!requester?.channel || isInternalMessageChannel(requester.channel)) {
        return;
      }
      const config = getConfig();
      if (
        !requester.authorizationSource ||
        !authority?.isCurrent(config) ||
        !isRestartEnabled(config)
      ) {
        throw new Error("Update requester authority changed before parking.");
      }
    },
  };
}

export async function resolveGatewayUpdateAdmission(runId: string, timeoutMs?: number) {
  recordUpdateRunStep(runId, { step: "installation-inspection", status: "in_progress" });
  const { root, status } = await currentUpdateCheckLifecycle().run((signal) =>
    resolveStartupInstallStatus(false, signal),
  );
  recordUpdateRunPhase(runId, "requested", {
    target: {
      ...(status.installKind === "unknown" ? {} : { kind: status.installKind }),
      ...(status.installKind === "git" ? { installationMethod: "git-checkout" } : {}),
    },
  });
  // Status discovery is read-only; admit ownership before campaign adoption
  // or a managed handoff can select and launch an updater.
  await createFreeBsdPkgOwnershipInspection(timeoutMs).assertUnowned(root);
  const installSurface = await resolveUpdateInstallSurface({
    root,
    installKind: status.installKind,
    timeoutMs,
  });
  recordUpdateRunPhase(runId, "requested", {
    ...(installSurface.kind === "global"
      ? { target: { installationMethod: `${installSurface.mode}-global` } }
      : {}),
    step: { step: "installation-inspection", status: "completed" },
  });
  return { status, installSurface };
}

export function recordHandoffFailure(
  runId: string,
  error: unknown,
  previous: UpdateRunResult,
  warn: (message: string) => void,
  stepName = "requested",
): UpdateRunResult {
  const { reason, failureFacts } =
    error instanceof UpdatePreMutationError
      ? error
      : {
          reason: "managed-service-handoff-failed",
          failureFacts: [createUpdateErrorFact("managed-service", error)],
        };
  const step = {
    name: stepName,
    command: "",
    cwd: previous.root ?? "",
    durationMs: 0,
    exitCode: null,
    failureFacts,
  };
  const warnWithoutThrowing = (message: string) => {
    try {
      warn(message);
    } catch {
      // Diagnostic sinks cannot replace the handoff's original cause.
    }
  };
  try {
    recordUpdateRunStep(runId, { step: step.name, status: "failed", reason });
  } catch {
    warnWithoutThrowing(
      "Update failure state could not be recorded; preserving the original error.",
    );
  }
  try {
    recordUpdateRunDiagnostics(
      runId,
      {
        failure: {
          step: step.name,
          exitCode: step.exitCode,
          detail: summarizeUpdateStepFailure(step),
          failureFacts,
        },
      },
      warnWithoutThrowing,
    );
  } catch {
    warnWithoutThrowing(
      "Update failure details could not be recorded; preserving the original error.",
    );
  }
  return { ...previous, status: "error", reason, steps: [...previous.steps, step] };
}

export function createUnexpectedUpdateFailureResult(
  current: UpdateRunRecord,
  previous: UpdateRunResult,
  error: unknown,
  warn: (message: string) => void,
): UpdateRunResult {
  const activeStep = current.steps.findLast((step) => step.status === "in_progress");
  const name = activeStep?.step ?? current.phase;
  const reason = error instanceof FreeBsdPkgOwnershipError ? error.reason : "unexpected-error";
  const step = {
    name,
    command: "",
    cwd: previous.root ?? "",
    durationMs: Date.now() - (activeStep?.startedAtMs ?? current.createdAtMs),
    exitCode: 1,
    failureFacts: [createUpdateErrorFact(name, error)],
  };
  const result: UpdateRunResult = {
    ...previous,
    status: "error",
    mode: previous.mode === "unknown" && current.target.kind === "git" ? "git" : previous.mode,
    reason,
    recovery: current.verification.recovery ?? previous.recovery,
    rollbackOutcome: current.verification.rollbackOutcome ??
      previous.rollbackOutcome ?? {
        status: "not-attempted",
        reason: "Gateway RPC does not perform rollback after an unexpected exception",
      },
    before: previous.before ?? current.before,
    after: previous.after ?? current.after,
    steps: [...previous.steps, step],
    durationMs: Date.now() - current.createdAtMs,
  };
  recordUpdateRunDiagnostics(
    current.runId,
    {
      recovery: result.recovery,
      rollbackOutcome: result.rollbackOutcome,
      failure: {
        step: name,
        exitCode: step.exitCode,
        detail: summarizeUpdateStepFailure(step),
        failureFacts: step.failureFacts,
      },
    },
    warn,
  );
  return result;
}

/** Project the Gateway-owned outcome before transferring an accepted helper. */
export async function recordGatewayUpdateOutcome(params: {
  runId: string;
  result: UpdateRunResult;
  nextAction?: string;
  handoffStarted: boolean;
  managedHandoffOwner: Parameters<typeof cancelManagedServiceUpdateHandoff>[0] | undefined;
  warn: (message: string) => void;
}) {
  const { runId, result, nextAction, handoffStarted, managedHandoffOwner, warn } = params;
  try {
    const outcome = recordUpdateRunPhase(runId, "requested", {
      before: result.before,
      after: result.after,
      ...(nextAction === undefined ? {} : { origin: { nextAction } }),
    });
    // A managed orchestrator or the replacement Gateway owns terminal success;
    // refusals and synchronous failures have no later process to finish the run.
    return handoffStarted
      ? outcome
      : finishUpdateRun(runId, {
          status: result.status === "skipped" ? "skipped" : "failed",
          reason: result.reason,
          after: result.after,
        });
  } catch (error) {
    // Projection may have committed before throwing. Do not repeat its writes;
    // this RPC owns the accepted helper until the explicit transfer.
    if (managedHandoffOwner) {
      const cancellation = await cancelManagedServiceUpdateHandoff(managedHandoffOwner).catch(
        () => false,
      );
      if (cancellation !== "restored-in-process") {
        try {
          warn(
            "update.run could not confirm managed handoff cancellation after result projection failed",
          );
        } catch {
          // Diagnostics must not replace the original projection error.
        }
      }
    }
    throw error;
  }
}
