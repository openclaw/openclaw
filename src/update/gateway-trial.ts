import { wakeUpdateRunWatcher } from "../gateway/update-run-watcher.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { updateRunStepsFromResultStep } from "../infra/update-run-step.js";
import {
  finishUpdateRunAsync,
  recordUpdateRunStepAsync,
  recordUpdateRunVerificationAsync,
} from "../infra/update-run-write.async.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
}

export async function settleRunFromTrial(
  trial: Trial | null,
  prefix = resolvePrefix(),
): Promise<void> {
  if (!trial?.outcome || trial.reported || !trial.runId) {
    return;
  }
  const outcome = trial.outcome;
  const finished =
    outcome.status === "succeeded"
      ? await finishSucceeded(trial)
      : await finishUpdateRunAsync(trial.runId, {
          status: "failed",
          reason: `${outcome.reason ?? "The new version did not start"}; v${VERSION} is still running`,
          ...(outcome.stderrTail
            ? {
                diagnostics: {
                  failure: {
                    step: "outcome",
                    detail: redactSensitiveText(outcome.stderrTail, { mode: "tools" }),
                  },
                },
              }
            : {}),
        });
  if (finished === null) {
    return;
  }
  if (outcome.status === "succeeded") {
    const step = "post-activation doctor inspections";
    // Advisory work never holds the committed trial handshake open; the watcher logs its failures.
    const accepted = wakeUpdateRunWatcher(trial.runId, async () => {
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
        for (const projected of result.steps.flatMap(updateRunStepsFromResultStep)) {
          await recordUpdateRunStepAsync(trial.runId, projected);
        }
        if (result.steps.length === 0) {
          await recordUpdateRunStepAsync(trial.runId, { step, status: "completed" });
        }
      } catch (error) {
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
    });
    if (!accepted) {
      log.warn(`update run ${trial.runId} inspections skipped: no Gateway update watcher`);
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

/** Only the release that actually booted may claim a successful activation. */
async function finishSucceeded(trial: Trial & { runId: string }) {
  const buildId = resolveRuntimeServiceBuildId();
  if (trial.buildId && buildId !== trial.buildId) {
    return null;
  }
  await recordUpdateRunVerificationAsync(trial.runId, {
    runningVersion: VERSION,
    ...(buildId ? { runningBuildId: buildId } : {}),
    booted: true,
  });
  return await finishUpdateRunAsync(trial.runId, {
    status: "succeeded",
    after: { version: VERSION, buildId },
  });
}

/** Called after the listener is serving, including the old release after a rollback. */
export async function announceReady(buildId: string | null): Promise<void> {
  const lock = await readUpdateLock();
  // A restarted container can reuse the old Gateway's PID (including PID 1).
  if (lock && (lock.dead || lock.pid === process.pid)) {
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
