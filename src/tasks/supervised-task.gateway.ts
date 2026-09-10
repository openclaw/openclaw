import { getRuntimeConfig } from "../config/config.js";
import {
  isGatewayWorkAdmissionClosed,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { registerSupervisedTaskAdmissionOwner } from "./supervised-task.admission-owner.js";
import { isTaskSupervisionActivated } from "./supervised-task.store.js";
import { startSupervisedTaskWorker } from "./supervised-task.worker.js";

/** Gateway lifecycle owns continuation; a chat turn or progress card does not. */
export function startGatewayTaskSupervision(params: {
  onError: (error: unknown) => void;
  runWithContext: (
    run: () => ReturnType<import("./supervised-task.worker.js").SupervisedAttemptRunner>,
  ) => ReturnType<import("./supervised-task.worker.js").SupervisedAttemptRunner>;
}): { stop: () => void } {
  const onError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      /* Logging cannot become authority. */
    }
  };
  let stopped = false;
  let preparation: Promise<void> | undefined;
  let notifications:
    | ReturnType<
        typeof import("./supervised-task.notifications.js").startSupervisedTaskNotifications
      >
    | undefined;
  let worker: ReturnType<typeof startSupervisedTaskWorker> | undefined;
  const prepare = async () => {
    if (stopped || isGatewayWorkAdmissionClosed() || (worker && !worker.stopped)) {
      return;
    }
    try {
      // Ordinary installations remain non-creating. The supervise CLI explicitly
      // activates this optional subsystem by admitting its first observer.
      if (
        !isTaskSupervisionActivated() &&
        !Object.values(getRuntimeConfig().agents?.entries ?? {}).some(
          (agent) => agent.taskSupervision?.enabled,
        )
      ) {
        return;
      }
      if (!notifications) {
        const { startSupervisedTaskNotifications } =
          await import("./supervised-task.notifications.js");
        if (stopped) {
          return;
        }
        notifications = startSupervisedTaskNotifications({ onError });
      }
      const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
        await import("./supervised-task.agent.js");
      await prepareSupervisedAgentRuntime();
      if (stopped || isGatewayWorkAdmissionClosed()) {
        return;
      }
      worker = startSupervisedTaskWorker({
        onError,
        canObserve: () => !isGatewayWorkAdmissionClosed(),
        acquireAttempt: () =>
          tryBeginGatewayIndependentRootWorkAdmission("taskflow:supervised-attempt"),
        runAttempt: async (task, context) => {
          context.assertCurrent();
          return params.runWithContext(() => runSupervisedAgentAttempt(task, context));
        },
      });
    } catch (error) {
      // A failed observation is not armed custody. Retry the native owner probe;
      // status readers independently expire the last durable observation.
      onError(error);
    }
  };
  const probe = () => {
    // Concurrent admissions await the same genuine owner preparation. Returning
    // early would reject custody simply because another request started it.
    preparation ??= prepare().finally(() => {
      preparation = undefined;
    });
    return preparation;
  };
  const timer = setInterval(() => void probe(), 5_000);
  timer.unref();
  const unregisterAdmission = registerSupervisedTaskAdmissionOwner(async () => {
    await probe();
    return !stopped && worker && !worker.stopped ? worker.ownerId : undefined;
  });
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    unregisterAdmission();
    worker?.stop();
    notifications?.stop();
  };
  void probe();
  return { stop };
}
