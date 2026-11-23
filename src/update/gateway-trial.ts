import { wakeUpdateRunWatcher } from "../gateway/update-run-watcher.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
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
import {
  readTrial,
  readUpdateLock,
  releaseUpdateLock,
  resolvePrefix,
  writeTrial,
  type Trial,
} from "./store.js";

const log = createSubsystemLogger("gateway/update-run");

/** The committed core keeps serving while its own code updates and reloads installed plugins. */
async function maintainTrialPlugins(trial: Trial): Promise<void> {
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
  } catch (error) {
    if (getAsyncWorkSignal()?.aborted) {
      return;
    }
    const detail = redactSensitiveText(
      [
        step?.detail,
        String(error),
        pluginIds.length > 0
          ? `Run \`openclaw plugins reload ${pluginIds.join(" ")}\` to retry activation.`
          : "Run `openclaw plugins update --all` to retry.",
      ]
        .filter(Boolean)
        .join("\n"),
      { mode: "tools" },
    );
    await recordUpdateRunStepAsync(trial.runId, {
      ...step,
      step: "plugins",
      status: "failed",
      endedAtMs: Date.now(),
      detail,
    });
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
  if (!trial?.outcome || trial.reported || !trial.runId) {
    return;
  }
  const outcome = trial.outcome;
  const buildId = resolveRuntimeServiceBuildId();
  // Only the release that actually booted may claim successful activation.
  if (outcome.status === "succeeded" && trial.buildId && buildId !== trial.buildId) {
    return;
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
    const step = "post-activation doctor inspections";
    // Advisory work never holds the committed trial handshake open; the watcher logs its failures.
    const accepted = wakeUpdateRunWatcher(trial.runId, () =>
      withCommandProcessScope(async () => {
        try {
          await maintainTrialPlugins(trial);
        } catch (error) {
          log.warn(
            `update run ${trial.runId} plugin result could not be recorded: ${String(error)}`,
          );
        }
        if (getAsyncWorkSignal()?.aborted) {
          return;
        }
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
          // The update stays successful; the skipped inspections are reported with a next step.
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
      log.warn(
        `update run ${trial.runId} post-update maintenance skipped: no Gateway update watcher`,
      );
    }
  }
  trial.reported = true;
  await writeTrial(trial, prefix);
  // A requester that received the start notice also hears the outcome (same rule as the run watcher).
  if (finished.steps.some((step) => step.step === "notice:ack" && step.status === "completed")) {
    const { createUpdateRunNotifier } = await import("../gateway/update-run-notice.runtime.js");
    await (
      await createUpdateRunNotifier(finished)
    )(finished, "finished");
  }
}

/** Called after the listener is serving, including the old release after a rollback. */
export async function announceReady(buildId: string | null): Promise<void> {
  const lock = await readUpdateLock();
  // A restarted container can reuse the old Gateway's PID (including PID 1). A lock with this
  // PID taken after this process started is this Gateway's own update in progress, not a leftover.
  const startedAt = Date.now() - process.uptime() * 1000;
  if (lock && (lock.dead || (lock.pid === process.pid && lock.startedAt < startedAt))) {
    await finishUpdateRunAsync(lock.runId, { status: "failed", reason: "interrupted" });
    await releaseUpdateLock();
  }
  await settleRunFromTrial(await readTrial());
  if (process.env.OPENCLAW_LAUNCHER_IPC !== "1" || !process.send || !process.connected) {
    return;
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
    await settleRunFromTrial(await promise);
  } finally {
    clearTimeout(timer);
    process.off("message", onMessage);
  }
}
