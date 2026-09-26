import { randomUUID } from "node:crypto";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { VERSION } from "../version.js";
import { extractErrorCode, formatErrorMessage } from "./errors.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart-budget.js";
import {
  readRestartSentinelSnapshot,
  writeRestartSentinelIfUnchanged,
} from "./restart-sentinel.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";
import type { TrackedDevUpdateTarget } from "./update-dev-target.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import {
  buildManagedServiceHandoffUnavailableMessage,
  formatManagedServiceUpdateCommand,
} from "./update-managed-service-handoff-command.js";
import {
  cancelManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
  transferManagedServiceUpdateHandoff,
} from "./update-managed-service-handoff.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunDiagnostics,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { AUTO_UPDATE_STEP_TIMEOUT_MS } from "./update-run-timeouts.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export type AutoUpdateRunResult =
  | { status: "handoff"; command?: string; logPath?: string }
  | { status: "failed" | "skipped"; result: UpdateRunResult; message: string };

export type AutoUpdateRunParams = {
  runId: string;
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
  packageTargetVersion?: string;
  devTarget?: TrackedDevUpdateTarget;
  signal?: AbortSignal;
};

export async function runAutoUpdateCommand(
  params: AutoUpdateRunParams,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<AutoUpdateRunResult> {
  const startedAt = Date.now();
  const command = formatManagedServiceUpdateCommand({
    channel: params.channel,
    ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
  });
  const failure = (
    reason: string,
    message: string,
    status: "error" | "skipped" = "error",
  ): Exclude<AutoUpdateRunResult, { status: "handoff" }> => ({
    status: "failed",
    result: {
      status,
      mode: params.mode,
      root: params.root,
      reason,
      before: { version: VERSION },
      steps: [],
      durationMs: Date.now() - startedAt,
    },
    message,
  });
  if (isGatewayExternallySupervised()) {
    return failure(
      EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      "Use the external supervisor's update workflow to stop, update, and restart the Gateway.",
      "skipped",
    );
  }
  const supervisor = detectRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (!supervisor) {
    return failure(
      "managed-service-handoff-unavailable",
      buildManagedServiceHandoffUnavailableMessage(command),
      "skipped",
    );
  }
  recordUpdateRunPhase(params.runId, "requested", {
    target: { installationMethod: "managed-service" },
  });
  const handoffFailure = (error: unknown): AutoUpdateRunResult => {
    log.info("automatic update handoff failed", { error: formatErrorMessage(error) });
    const reason = "managed-service-handoff-failed";
    const fact = createUpdateErrorFact("managed-service", error);
    // Cancellation may finish the run; retain its cause before that ownership transition.
    try {
      recordUpdateRunStep(params.runId, { step: "requested", status: "failed", reason });
    } catch {
      log.info("Update failure state could not be recorded; preserving the original error.");
    }
    recordUpdateRunDiagnostics(
      params.runId,
      { failure: { step: "managed-service", detail: fact.message, failureFacts: [fact] } },
      (message) => log.info(message),
    );
    const code = extractErrorCode(error);
    const outcome = failure(
      reason,
      `Automatic update handoff failed${code ? ` (${code})` : ""}. Inspect the Gateway log, then run \`${command}\` from a shell to retry.`,
    );
    outcome.result.steps = [
      {
        name: "managed-service",
        command: "",
        cwd: "",
        durationMs: 0,
        exitCode: 1,
        failureFacts: [fact],
      },
    ];
    outcome.result.rollbackOutcome = {
      status: "not-attempted",
      reason: "Automatic handoff does not perform package rollback after an exception",
    };
    return outcome;
  };

  try {
    params.signal?.throwIfAborted();
    if (!params.root?.trim()) {
      throw new Error("managed auto-update install root is unavailable");
    }
    const handoffId = randomUUID();
    const started = await startManagedServiceUpdateHandoff({
      root: params.root,
      recoveryTimeoutMs: params.timeoutMs,
      restartDrainTimeoutMs:
        resolveGatewayRestartDeferralTimeoutMs(params.restartDrainTimeoutMs) ??
        resolveGatewayRestartDeferralTimeoutMs(),
      channel: params.channel,
      ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
      supervisor,
      handoffId,
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      meta: { runId: params.runId, handoffId, note: "background auto-update" },
    });
    if (started.status === "started") {
      const successorOwner = {
        kind: "managed-update-handoff" as const,
        handoffId: started.handoffId,
        installRoot: started.installRoot,
      };
      if (params.signal?.aborted) {
        const cancelled = await cancelManagedServiceUpdateHandoff(successorOwner);
        if (cancelled !== "restored-in-process") {
          log.info("stopped auto-update handoff cancellation could not be verified", {
            result: cancelled,
            command: started.command,
            logPath: started.logPath,
          });
        }
        params.signal.throwIfAborted();
      }
      // Transfer starts validation while this generation remains available. Only
      // the orchestrator's activation request may park the managed service.
      try {
        if (!(await transferManagedServiceUpdateHandoff(successorOwner))) {
          throw new Error("managed update ownership transfer failed");
        }
        params.signal?.throwIfAborted();
      } catch (error) {
        const outcome = handoffFailure(error);
        await cancelManagedServiceUpdateHandoff(successorOwner);
        return outcome;
      }
    } else {
      // A joined helper owns another run; it cannot complete this campaign's admission.
      finishUpdateRun(params.runId, {
        status: "skipped",
        reason: "managed-service-handoff-already-running",
      });
    }
    return {
      status: "handoff",
      command: started.command,
      logPath: started.logPath,
    };
  } catch (err) {
    return handoffFailure(err);
  }
}

export type AutoUpdateRunner = (params: AutoUpdateRunParams) => Promise<AutoUpdateRunResult>;

// The owner joins handoff readiness, never the helper's subsequent wait for Gateway exit.
export async function runCampaignUpdate(params: {
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  version: string;
  tag: string;
  forced: boolean;
  root?: string;
  devTarget?: TrackedDevUpdateTarget;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  runAuto: AutoUpdateRunner;
  canApply: () => boolean;
  campaign: UpdateCampaignController;
  onAttempt: (version: string) => void;
  onUpdateRunCreated?: () => void;
  signal?: AbortSignal;
}): Promise<"handoff" | "applied" | "failed"> {
  const campaignId = params.campaign.getState()?.id;
  const isCurrent = () =>
    campaignId !== undefined &&
    !params.signal?.aborted &&
    params.campaign.getState()?.id === campaignId;
  // The countdown may outlive its config. After this admission, the applying
  // owner retains its target until handoff or stop/drain settles it.
  if (campaignId === undefined || !isCurrent() || !params.canApply()) {
    return "failed";
  }
  const run = createUpdateRun({
    trigger: "campaign",
    origin: { campaignId },
    target: {
      channel: params.channel,
      tag: params.tag,
      kind: params.mode === "git" ? "git" : "package",
      ...(params.mode === "unknown"
        ? {}
        : { installationMethod: params.mode === "git" ? "git-checkout" : `${params.mode}-global` }),
      ...(params.mode === "git" ? { sha: params.version } : { version: params.version }),
    },
    before: { version: VERSION },
  });
  const runId = run.runId;
  params.campaign.bindRun(campaignId, runId);
  params.onUpdateRunCreated?.();
  const { channel, forced, tag, version } = params;
  const attempt = { channel, forced, tag, version };
  let terminal: Parameters<typeof finishUpdateRun>[1] | undefined = {
    status: "failed",
    reason: "unexpected-error",
  };
  try {
    // Capture recovery code before the updater can replace the running installation.
    const { runUpdateFailureTriage } = await import("./update-triage.js");
    const { sentinel, revision } = await readRestartSentinelSnapshot();
    if (!isCurrent()) {
      return "failed";
    }
    params.onAttempt(params.version);

    const outcome = await params.runAuto({
      runId,
      channel: params.channel,
      mode: params.mode,
      timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
      restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
      ...(params.root ? { root: params.root } : {}),
      ...(params.channel === "dev" ? {} : { packageTargetVersion: params.version }),
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (outcome.status === "handoff") {
      terminal = undefined;
      recordUpdateRunStep(runId, {
        step: "managed-service update handoff",
        status: "completed",
        endedAtMs: Date.now(),
      });
      if (!isCurrent()) {
        return "failed";
      }
      params.log.info("auto-update handoff started", {
        ...attempt,
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(outcome.logPath ? { logPath: outcome.logPath } : {}),
      });
      return "handoff";
    }
    terminal = {
      status: outcome.result.status === "skipped" ? "skipped" : "failed",
      reason: outcome.result.reason,
      after: outcome.result.after,
    };
    recordUpdateRunDiagnostics(
      runId,
      (recorded) => ({
        recovery: outcome.result.recovery && (recorded.recovery ?? outcome.result.recovery),
        rollbackOutcome:
          outcome.result.rollbackOutcome &&
          (recorded.rollbackOutcome ?? outcome.result.rollbackOutcome),
      }),
      (message) => params.log.info(message),
    );
    recordUpdateRunPhase(runId, "requested", {
      before: outcome.result.before,
      origin: { nextAction: outcome.message },
    });
    for (const step of outcome.result.steps.flatMap(updateRunStepsFromResultStep)) {
      recordUpdateRunStep(runId, { ...step, endedAtMs: Date.now() });
    }
    if (!isCurrent()) {
      return "failed";
    }
    let triageHint: string | undefined;
    if (classifyUpdateOutcome(outcome.result) === "failed") {
      const triage = await runUpdateFailureTriage({
        failure: { result: outcome.result, error: outcome.message },
        target: { root: params.root, env: process.env },
        mode: "json",
        runtime: {
          log: (message) => params.log.info(message),
          error: (message) => params.log.info(message),
        },
        signal: params.signal,
        isCurrent,
      });
      if (triage.status !== "cancelled") {
        triageHint = triage.hint;
        recordUpdateRunPhase(runId, "requested", { origin: { doctorHint: triageHint } });
      }
    }
    if (!isCurrent()) {
      return "failed";
    }
    // Publish before campaign-ended observers refresh status. A concurrent restart
    // or update keeps its notification; this attempt may replace only its snapshot.
    if (!sentinel || !isPendingControlPlaneUpdateRestartSentinel(sentinel.payload)) {
      await writeRestartSentinelIfUnchanged({
        payload: {
          ...buildUpdateRestartSentinelPayload({
            result: outcome.result,
            meta: { runId, root: params.root, note: outcome.message },
          }),
          ...(triageHint ? { doctorHint: triageHint } : {}),
        },
        expectedRevision: revision,
        isCurrent,
      });
    }
    const skipped = classifyUpdateOutcome(outcome.result) === "noop";
    params.log.info(skipped ? "auto-update attempt skipped" : "auto-update attempt failed", {
      ...attempt,
      reason: outcome.result.reason,
      message: outcome.message,
      ...(triageHint ? { triage: triageHint } : {}),
    });
    if (skipped) {
      finishUpdateRun(runId, terminal);
      terminal = undefined;
      params.campaign.clear();
    }
    return skipped ? "applied" : "failed";
  } catch (error) {
    const detail = formatErrorMessage(error);
    params.log.info(`auto-update attempt failed error=${detail}`, attempt);
    // A handed-off run belongs to the successor; only finish campaign-owned work.
    if (terminal) {
      terminal.status = "failed";
      terminal.reason = extractErrorCode(error) || "unexpected-error";
      let current = run;
      try {
        current = getUpdateRun(runId) ?? run;
      } catch {
        params.log.info(
          "Update history could not be read; preserving the original automatic update failure with captured admission facts.",
        );
      }
      const step =
        current.steps.findLast((entry) => entry.status === "in_progress")?.step ?? current.phase;
      const fact = createUpdateErrorFact(step, error);
      recordUpdateRunDiagnostics(
        runId,
        { failure: { step, detail: fact.message, failureFacts: [fact] } },
        (message) => params.log.info(message),
      );
      recordUpdateRunDiagnostics(
        runId,
        (recorded) => ({
          rollbackOutcome: recorded.rollbackOutcome ?? {
            status: "not-attempted",
            reason: "The startup campaign does not roll back a failed automatic update handoff",
          },
        }),
        (message) => params.log.info(message),
      );
    }
    throw error;
  } finally {
    if (terminal) {
      finishUpdateRun(runId, terminal);
    }
  }
}
