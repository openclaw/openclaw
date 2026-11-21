import { redactSensitiveText } from "../logging/redact.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { finishRun } from "./runs.js";
import { readTrial, resolvePrefix, writeTrial, type Trial } from "./store.js";

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
      ? finishSucceeded(trial)
      : finishRun(trial.runId, {
          status: "failed",
          reason: outcome.reason,
          detail: outcome.stderrTail
            ? redactSensitiveText(outcome.stderrTail, { mode: "tools" })
            : undefined,
        });
  if (finished === null) {
    return;
  }
  trial.reported = true;
  await writeTrial(trial, prefix);
  // A requester that received the start notice also hears the outcome (same rule as the run watcher).
  if (finished?.steps.some((step) => step.step === "notice:ack" && step.status === "completed")) {
    const { createUpdateRunNotifier } = await import("../gateway/update-run-notice.runtime.js");
    await (
      await createUpdateRunNotifier(finished)
    )(finished, "finished");
  }
}

/** Only the release that actually booted may claim a successful activation. */
function finishSucceeded(trial: Trial & { runId: string }) {
  const buildId = resolveRuntimeServiceBuildId();
  if (trial.buildId && buildId !== trial.buildId) {
    return null;
  }
  return finishRun(trial.runId, {
    status: "succeeded",
    after: { version: VERSION, buildId },
    verification: { runningVersion: VERSION, runningBuildId: buildId ?? undefined, booted: true },
  });
}

/** Called after the listener is serving, including the old release after a rollback. */
export async function announceReady(buildId: string | null): Promise<void> {
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
      // The launcher is the only peer on this private Node IPC channel.
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
