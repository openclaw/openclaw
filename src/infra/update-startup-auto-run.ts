import { classifyUpdateOutcome } from "../shared/update-outcome-classification.js";
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
import { scheduleGatewayRestart } from "./restart.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import { channelToNpmTag } from "./update-channels.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";
import type { TrackedDevUpdateTarget } from "./update-dev-target.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { getUpdateRunAsync as getUpdateRun, listUpdateRunsAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { AUTO_UPDATE_STEP_TIMEOUT_MS } from "./update-run-timeouts.js";
import {
  createUpdateRunAsync as createUpdateRun,
  finishUpdateRunAsync as finishUpdateRun,
  recordUpdateRunPhaseAsync as recordUpdateRunPhase,
  recordUpdateRunDiagnosticsAsync as recordUpdateRunDiagnostics,
  recordUpdateRunStepAsync as recordUpdateRunStep,
} from "./update-run-write.async.js";
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

/**
 * Stages the release into the unused runtime slot inside this Gateway, then
 * restarts it. The Gateway that confirms the slot, or that the launcher
 * returns to, finishes the run.
 */
export async function runAutoUpdateCommand(
  params: AutoUpdateRunParams,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<AutoUpdateRunResult> {
  const startedAt = Date.now();
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
  if (!params.root?.trim()) {
    return failure("not-openclaw-root", "The OpenClaw install root is unavailable.");
  }
  const { resolveUpdateOwner, runRuntimeSlotUpdate } =
    await import("../cli/update-cli/update-slots.js");
  try {
    const owner = await resolveUpdateOwner(
      resolveUpdateInstallRoot(params.root),
      params.packageTargetVersion ?? channelToNpmTag(params.channel),
    );
    if (owner.kind === "external") {
      return failure(owner.reason, owner.message, "skipped");
    }
    params.signal?.throwIfAborted();
    const outcome = await runRuntimeSlotUpdate(
      {
        channel: params.channel,
        ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
        ...(params.devTarget ? { sha: params.devTarget.upstreamSha } : {}),
        timeout: String(Math.ceil(params.timeoutMs / 1000)),
        yes: true,
        runId: params.runId,
        restartSelf: () => scheduleGatewayRestart({ delayMs: 0, reason: "update.auto" }),
        log: (line) => log.info(`auto-update ${line.trim()}`),
      },
      owner,
    );
    if (outcome.restart === "self") {
      return { status: "handoff", command: "openclaw update (runtime slot)" };
    }
    return failure(
      outcome.reason ?? "runtime-slot-update-failed",
      outcome.message,
      outcome.status === "error" ? "error" : "skipped",
    );
  } catch (error) {
    log.info("automatic update failed", { error: formatErrorMessage(error) });
    return failure("runtime-slot-update-failed", formatErrorMessage(error));
  }
}

export type AutoUpdateRunner = (params: AutoUpdateRunParams) => Promise<AutoUpdateRunResult>;

// A release that fails these checks rolls back; retrying the same release fails the same way.
const ACTIVATION_CHECK_STEPS = new Set([
  "openclaw doctor",
  "post-update verification",
  "activated-gateway-startup",
]);

function activationFailureSignature(run: UpdateRunRecord): string | undefined {
  if (run.trigger !== "campaign" || run.status !== "failed" || !run.reason) {
    return undefined;
  }
  const failed = run.steps.filter(
    (step) => step.status === "failed" && ACTIVATION_CHECK_STEPS.has(step.step),
  );
  if (!failed.length) {
    return undefined;
  }
  // Elapsed time changes between identical failures.
  const stable = (detail: string | undefined) => detail?.replace(/\(\d+ms\)/gu, "(elapsed)");
  return JSON.stringify([
    run.reason,
    failed
      .toSorted((a, b) => a.step.localeCompare(b.step))
      .map((step) => [
        step.step,
        step.exitCode,
        step.failureFacts?.length
          ? step.failureFacts
              .map((fact) =>
                JSON.stringify([
                  fact.check,
                  fact.code,
                  fact.affectedKey,
                  fact.pluginId,
                  stable(fact.message),
                ]),
              )
              .toSorted()
          : stable(step.detail),
      ]),
  ]);
}

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
  onAttempt: (version: string) => Promise<void> | void;
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
  const recent = await listUpdateRunsAsync({ limit: 2, excludeReason: "dry-run" }).catch(
    (error: unknown) => {
      params.log.info(
        "Warning: Automatic update retry history is unavailable; continuing update.",
        {
          error: formatErrorMessage(error),
        },
      );
      return [];
    },
  );
  if (!isCurrent() || !params.canApply()) {
    return "failed";
  }
  const signature = recent[0] && activationFailureSignature(recent[0]);
  // The existing terminal rows are the durable backoff fact. A new candidate or
  // an intervening operator run breaks the pair without another state store.
  if (
    signature &&
    recent.length === 2 &&
    recent.every(
      (run) =>
        run.target.channel === params.channel &&
        (params.mode === "git" ? run.target.sha : run.target.version) === params.version &&
        activationFailureSignature(run) === signature,
    )
  ) {
    const nextAction =
      "Inspect `openclaw update status`, resolve the reported check, then run `openclaw update` to retry; a new candidate also resumes automatic updates.";
    params.log.info(
      `Warning: Automatic updates paused after repeated activation failure. ${nextAction}`,
      {
        version: params.version,
        reason: recent[0]?.reason,
        runIds: recent.map((run) => run.runId),
        nextAction,
      },
    );
    return "failed";
  }
  const run = await createUpdateRun({
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
    await params.onAttempt(params.version);
    if (!isCurrent()) {
      return "failed";
    }

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
      await recordUpdateRunStep(runId, {
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
    await recordUpdateRunDiagnostics(
      runId,
      { recovery: outcome.result.recovery, rollbackOutcome: outcome.result.rollbackOutcome },
      (message) => params.log.info(message),
      { preserveRecovery: true },
    );
    await recordUpdateRunPhase(runId, "requested", {
      before: outcome.result.before,
      origin: { nextAction: outcome.message },
    });
    for (const step of outcome.result.steps.flatMap(updateRunStepsFromResultStep)) {
      await recordUpdateRunStep(runId, { ...step, endedAtMs: Date.now() });
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
        await recordUpdateRunPhase(runId, "requested", { origin: { doctorHint: triageHint } });
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
    if (!isCurrent()) {
      return "failed";
    }
    const skipped = classifyUpdateOutcome(outcome.result) === "noop";
    params.log.info(skipped ? "auto-update attempt skipped" : "auto-update attempt failed", {
      ...attempt,
      reason: outcome.result.reason,
      message: outcome.message,
      ...(triageHint ? { triage: triageHint } : {}),
    });
    if (skipped) {
      await finishUpdateRun(runId, terminal);
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
        current = (await getUpdateRun(runId)) ?? run;
      } catch {
        params.log.info(
          "Update history could not be read; preserving the original automatic update failure with captured admission facts.",
        );
      }
      const step =
        current.steps.findLast((entry) => entry.status === "in_progress")?.step ?? current.phase;
      const fact = createUpdateErrorFact(step, error);
      await recordUpdateRunDiagnostics(
        runId,
        { failure: { step, detail: fact.message, failureFacts: [fact] } },
        (message) => params.log.info(message),
      );
      await recordUpdateRunDiagnostics(
        runId,
        {
          rollbackOutcome: {
            status: "not-attempted",
            reason: "The startup campaign does not roll back a failed automatic update handoff",
          },
        },
        (message) => params.log.info(message),
        { preserveRecovery: true },
      );
    }
    throw error;
  } finally {
    if (terminal) {
      await finishUpdateRun(runId, terminal);
    }
  }
}
