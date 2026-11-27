import { wakeUpdateRunWatcher } from "../gateway/update-run-watcher.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunStep } from "../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../infra/update-run-step.js";
import {
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
  recordUpdateRunVerificationAsync,
} from "../infra/update-run-write.async.js";
import { redactSensitiveText } from "../logging/redact.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import {
  readTrial,
  readUpdateLock,
  releaseUpdateLock,
  resolvePrefix,
  writeTrial,
  type Trial,
} from "./store.js";

/** The committed core keeps serving while its own code updates and reloads installed plugins. */
async function maintainTrialPlugins(trial: Trial): Promise<{ nextAction?: string } | undefined> {
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
      acceptCapabilities: trial.acceptCapabilities === true,
    });
    step = result.step;
    const targets = result.plugins?.reloadTargets ?? [];
    pluginIds = targets.map((target) => target.pluginId);
    if (targets.length > 0) {
      if (!reload) {
        throw new Error("The serving Gateway was not found for plugin reload");
      }
      // The child released its lease; the batch owner verifies its exact published install hashes.
      const application = await reload(targets);
      if (application.restartRequired || application.warnings?.length) {
        throw new Error(
          application.warnings?.join("\n") || "Gateway restart required to load edited code.",
        );
      }
    }
    getAsyncWorkSignal()?.throwIfAborted();
    step.endedAtMs = Date.now();
    await recordUpdateRunStepAsync(trial.runId, step);
    return result;
  } catch (error) {
    if (getAsyncWorkSignal()?.aborted) {
      return undefined;
    }
    const nextAction =
      pluginIds.length > 0
        ? `openclaw plugins reload ${pluginIds.join(" ")}`
        : "openclaw plugins update --all";
    const detail = redactSensitiveText(
      [step?.detail, String(error), `Run \`${nextAction}\` to retry activation.`]
        .filter(Boolean)
        .join("\n"),
      { mode: "tools" },
    );
    step = {
      ...step,
      step: "plugins",
      status: "failed",
      endedAtMs: Date.now(),
      detail,
    };
    await recordUpdateRunStepAsync(trial.runId, step);
    return { nextAction };
  }
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

export async function settleRunFromTrial(
  trial: Trial | null,
  prefix = resolvePrefix(),
): Promise<void> {
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
    if (outcome.status === "succeeded") {
      await recordUpdateRunPhaseAsync(trial.runId, "verifying", {
        after: { version: VERSION, ...(buildId ? { buildId } : {}) },
        step: { step: "plugins", status: "in_progress", startedAtMs: Date.now() },
      });
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
    const finish = async (nextAction?: string) => {
      const finished = await finishUpdateRunAsync(
        trial.runId,
        outcome.status === "succeeded"
          ? {
              status: "succeeded",
              after: { version: VERSION, buildId },
              ...(nextAction ? { nextAction } : {}),
            }
          : {
              status: "failed",
              reason: `${outcome.reason ?? "The new version did not start"}; v${VERSION} is still running`,
            },
      );
      if (
        finished.steps.some((step) => step.step === "notice:ack" && step.status === "completed")
      ) {
        const { createUpdateRunNotifier } = await import("../gateway/update-run-notice.runtime.js");
        await (
          await createUpdateRunNotifier(finished)
        )(finished, "finished");
      }
    };
    if (outcome.status === "succeeded") {
      // The launcher committed already; only the aggregate result waits for required plugins.
      const accepted = wakeUpdateRunWatcher(trial.runId, () =>
        withCommandProcessScope(async () => {
          const step = "post-activation doctor inspections";
          const plugins = await maintainTrialPlugins(trial);
          if (getAsyncWorkSignal()?.aborted || !plugins) {
            return;
          }
          await finish(plugins.nextAction);
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
              await recordUpdateRunStepAsync(trial.runId, projected);
            }
            if (result.steps.length === 0) {
              await recordUpdateRunStepAsync(trial.runId, { step, status: "completed" });
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
            await recordUpdateRunStepAsync(trial.runId, { step, status: "completed", detail });
            await recordUpdateRunStepAsync(trial.runId, {
              step: `warning:${step}`,
              status: "completed",
              detail,
            });
          }
        }, getAsyncWorkSignal()),
      );
      if (!accepted) {
        const nextAction = "openclaw plugins update --all";
        const step: UpdateRunStep = {
          step: "plugins",
          status: "failed",
          endedAtMs: Date.now(),
          detail: `Plugin activation did not run because the Gateway update watcher is unavailable. Run \`${nextAction}\`.`,
        };
        await recordUpdateRunStepAsync(trial.runId, step);
        await finish(nextAction);
      }
    } else {
      await finish();
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
  process.on("message", onMessage);
  const timer = setTimeout(() => resolve(null), 2000);
  try {
    process.send({ type: "openclaw.ready", buildId }, (error) => {
      if (error) {
        reject(error);
      }
    });
    const confirmed = await promise;
    await settleRunFromTrial(confirmed ?? (await readTrial()));
  } finally {
    clearTimeout(timer);
    process.off("message", onMessage);
  }
}
