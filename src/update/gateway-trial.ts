import { wakeUpdateRunWatcher } from "../gateway/update-run-watcher.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { getUpdateRunAsync, getUpdateRunStatusAsync } from "../infra/update-run-reader.js";
import type { UpdateRunStep } from "../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../infra/update-run-step.js";
import {
  finishUpdateRunAsync,
  recordUpdateRunStepAsync,
  recordUpdateRunVerificationAsync,
} from "../infra/update-run-write.async.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import type { LegacyTrial } from "./legacy-trial-record.js";
import {
  collectReleases,
  readTrial,
  readUpdateLock,
  releaseUpdateLock,
  resolvePrefix,
  writeTrial,
  type Trial,
} from "./store.js";

const log = createSubsystemLogger("gateway/update-run");

/** Every ready boot converges installed plugins without holding core readiness open. */
export function schedulePluginMaintenance(): void {
  wakeUpdateRunWatcher(undefined, () =>
    withCommandProcessScope(async () => {
      const phase = (await readTrial(resolvePrefix()))?.phase;
      if (phase === "pending" || phase === "trial" || phase === "restoring") {
        return;
      }
      let pluginIds: string[] = [];
      let step: UpdateRunStep | undefined;
      try {
        // Updater and plugin-install modules stay off the Gateway's startup path.
        const [
          { runPluginMaintenance },
          { readUpdateChannelConfig },
          { resolveEffectiveUpdateChannel },
          { resolveStartupInstallStatus },
          { resolvePluginBatchReload },
        ] = await Promise.all([
          import("./run.js"),
          import("../cli/update-cli/update-command-config.js"),
          import("../infra/update-channels.js"),
          import("../infra/update-install-status.js"),
          import("../cli/plugins-lifecycle-client.js"),
        ]);
        const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
        if (!root) {
          throw new Error("Running release root not found");
        }
        const [{ storedChannel }, { status }, reload] = await Promise.all([
          readUpdateChannelConfig(false),
          resolveStartupInstallStatus(false, new AbortController().signal),
          resolvePluginBatchReload(),
        ]);
        const result = await runPluginMaintenance({
          root,
          node: process.execPath,
          env: process.env,
          channel: resolveEffectiveUpdateChannel({
            configChannel: storedChannel,
            currentVersion: VERSION,
            installKind: status.installKind,
            git: status.git,
          }).channel,
          timeoutMs: 10 * 60_000,
        });
        step = result.step;
        const targets = result.plugins?.reloadTargets ?? [];
        pluginIds = targets.map((target) => target.pluginId);
        if (targets.length > 0) {
          if (!reload) {
            throw new Error("The serving Gateway was not found for plugin reload");
          }
          // The child released its lease; the batch owner verifies its published install hashes.
          const application = await reload(targets);
          if (application.restartRequired) {
            throw new Error(
              application.warnings?.join("\n") || "Gateway restart required to load edited code.",
            );
          }
          if (application.warnings?.length) {
            step.detail = redactSensitiveText(
              [step.detail, ...application.warnings].filter(Boolean).join("\n"),
              { mode: "tools" },
            );
          }
        }
        getAsyncWorkSignal()?.throwIfAborted();
        step.endedAtMs = Date.now();
      } catch (error) {
        if (getAsyncWorkSignal()?.aborted) {
          return;
        }
        const nextAction =
          pluginIds.length > 0
            ? `openclaw plugins reload ${pluginIds.join(" ")}`
            : "openclaw plugins update --all";
        step = {
          ...step,
          step: "plugins",
          status: "failed",
          endedAtMs: Date.now(),
          detail: redactSensitiveText(
            [step?.detail, String(error), `Run \`${nextAction}\` to retry activation.`]
              .filter(Boolean)
              .join("\n"),
            { mode: "tools" },
          ),
        };
      }
      // History is only an output: ordinary boots neither create runs nor send notices.
      const { lastRun } = await getUpdateRunStatusAsync();
      const pluginStep = lastRun?.steps.find((entry) => entry.step === "plugins");
      if (
        lastRun?.after?.version === VERSION &&
        (!pluginStep || pluginStep.status === "pending" || pluginStep.status === "in_progress") &&
        (!lastRun.after.buildId || lastRun.after.buildId === resolveRuntimeServiceBuildId())
      ) {
        await recordUpdateRunStepAsync(lastRun.runId, step);
        wakeUpdateRunWatcher(lastRun.runId);
      } else if (step.detail) {
        // A successful child can defer repair. With no writable history step,
        // its warning detail is the operator's only recovery guidance.
        log.warn(step.detail);
      }
    }, getAsyncWorkSignal()),
  );
}

async function runPostUpdateInspections(runId: string): Promise<void> {
  const step = "post-activation doctor inspections";
  try {
    const [{ runPostActivationInspections }, { resolvePostActivationInspectionCheckIds }] =
      await Promise.all([
        import("../cli/update-cli/update-command-post-activation-inspections.js"),
        import("../flows/doctor-health-contributions.js"),
      ]);
    const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    if (!root) {
      throw new Error("Running release root not found");
    }
    const result = await runPostActivationInspections({
      root,
      gatewayReady: true,
      checkIds: await resolvePostActivationInspectionCheckIds(),
      timeoutMs: 120_000,
      result: { status: "ok", mode: "unknown", steps: [], durationMs: 0 },
    });
    getAsyncWorkSignal()?.throwIfAborted();
    for (const projected of result.steps.flatMap(updateRunStepsFromResultStep)) {
      await recordUpdateRunStepAsync(runId, projected);
    }
    if (result.steps.length === 0) {
      await recordUpdateRunStepAsync(runId, { step, status: "completed" });
    }
  } catch (error) {
    if (getAsyncWorkSignal()?.aborted) {
      return;
    }
    // Advisory inspections cannot change the settled aggregate result.
    const detail = redactSensitiveText(
      `Doctor inspections did not run after the update (${String(error)}). Run \`openclaw doctor --lint --all\` to check this install.`,
      { mode: "tools" },
    ).slice(0, 2000);
    await recordUpdateRunStepAsync(runId, { step, status: "completed", detail });
    await recordUpdateRunStepAsync(runId, {
      step: `warning:${step}`,
      status: "completed",
      detail,
    });
  }
}

function schedulePostUpdateInspections(runId: string): void {
  wakeUpdateRunWatcher(runId, () =>
    withCommandProcessScope(() => runPostUpdateInspections(runId), getAsyncWorkSignal()),
  );
}

// IPC also reaches Windows, where POSIX signals cannot request a graceful child stop.
if (process.env.OPENCLAW_LAUNCHER_IPC === "1") {
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "openclaw.stop"
    ) {
      process.kill(process.pid, "SIGTERM");
    }
  });
  // The listener must receive stop requests without keeping a settled Gateway alive.
  process.channel?.unref();
}

async function settleRunFromTrial(trial: Trial | null, prefix = resolvePrefix()): Promise<void> {
  // Ready releases prune by owned path; stale updater records do not gate preparation.
  void collectReleases(prefix).catch(() => undefined);
  if (
    trial?.outcome &&
    trial.runId &&
    (!trial.reported || (await getUpdateRunAsync(trial.runId))?.status === "running")
  ) {
    const outcome = trial.outcome;
    const buildId = resolveRuntimeServiceBuildId();
    // Only the release that actually booted may claim successful activation.
    if (outcome.status === "succeeded" && trial.buildId && buildId !== trial.buildId) {
      return;
    }
    if (!trial.reported) {
      trial.reported = true;
      await writeTrial(trial, prefix);
    }
    // The terminal trial handed ownership to this Gateway, not its expired preparer.
    const preparationLock = await readUpdateLock(prefix);
    if (preparationLock?.dead) {
      await releaseUpdateLock(prefix);
    }
    await recordUpdateRunVerificationAsync(trial.runId, {
      runningVersion: VERSION,
      ...(buildId ? { runningBuildId: buildId } : {}),
      booted: true,
      serviceRunning: true,
      coreReady: true,
      ...(outcome.status === "succeeded"
        ? { versionMatch: true }
        : {
            rollbackOutcome: {
              status: "succeeded",
              reason: outcome.reason ?? "new build failed to start",
            },
          }),
    });
    if (outcome.status === "rolled-back" && outcome.stderrTail) {
      const stderrTail = redactSensitiveText(outcome.stderrTail, { mode: "tools" });
      await recordUpdateRunStepAsync(trial.runId, {
        step: "diagnostic:startup",
        status: "completed",
        detail: stderrTail,
        stderrTail,
      });
    }
    const finished = await finishUpdateRunAsync(
      trial.runId,
      outcome.status === "succeeded"
        ? { status: "succeeded", after: { version: VERSION, buildId } }
        : {
            status: "failed",
            reason: `${outcome.reason ?? "The new version did not start"}; v${VERSION} is still running`,
          },
    );
    if (outcome.status === "succeeded") {
      schedulePostUpdateInspections(trial.runId);
    }
    if (finished.steps.some((step) => step.step === "notice:ack" && step.status === "completed")) {
      const { createUpdateRunNotifier } = await import("../gateway/update-run-notice.runtime.js");
      await (
        await createUpdateRunNotifier(finished)
      )(finished, "finished");
    }
    return;
  }
  // Preparation refuses an active trial after taking its lock.
  switch (trial?.phase) {
    case "pending":
    case "trial":
    case "restoring":
      return;
    case undefined:
    case "committed":
    case "rolled-back":
      break;
  }
  const lock = await readUpdateLock(prefix);
  if (lock?.dead) {
    if ((await getUpdateRunAsync(lock.runId))?.status === "running") {
      await finishUpdateRunAsync(lock.runId, { status: "failed", reason: "interrupted" });
    }
    await releaseUpdateLock(prefix);
  }
}

/** Separately retire the legacy rollback trial at core readiness. */
export async function observeLegacyTrialReadiness(
  buildId: string | null,
  runningRoot: string | null,
  captured?: LegacyTrial,
): Promise<(() => Promise<boolean>) | undefined> {
  const { disarmLegacyTrial, recoverLegacyTrialRun } = await import("./legacy-trial.js");
  const receipt = await disarmLegacyTrial(runningRoot, buildId, captured);
  return receipt && (() => recoverLegacyTrialRun(receipt, schedulePostUpdateInspections));
}

/** Called after the listener is serving, including the old release after a rollback. */
export async function announceReady(buildId: string | null): Promise<void> {
  if (process.env.OPENCLAW_LAUNCHER_IPC !== "1" || !process.send || !process.connected) {
    return await settleRunFromTrial(await readTrial());
  }
  const { promise, resolve, reject } = Promise.withResolvers<Trial | null>();
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "openclaw.trial" &&
      "trial" in message
    ) {
      // SAFETY: the launcher is the only peer on this private Node IPC channel and sends its trial record.
      resolve(message.trial as Trial | null);
    }
  };
  const onDisconnect = () => resolve(null);
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  try {
    process.send({ type: "openclaw.ready", buildId }, (error) => {
      if (error) {
        reject(error);
      }
    });
    const confirmed = await promise;
    await settleRunFromTrial(confirmed ?? (await readTrial()));
  } finally {
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
  }
}
