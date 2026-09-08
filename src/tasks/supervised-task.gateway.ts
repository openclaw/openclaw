import {
  isGatewayWorkAdmissionClosed,
  tryBeginGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { isTaskSupervisionActivated } from "./supervised-task.store.js";
import { startSupervisedTaskWorker } from "./supervised-task.worker.js";

/** Gateway lifecycle owns continuation; a chat turn or progress card does not. */
export function startGatewayTaskSupervision(params: {
  onError: (error: unknown) => void;
  runWithContext: (
    run: () => Promise<import("./supervised-task.types.js").SupervisedDecision>,
  ) => Promise<import("./supervised-task.types.js").SupervisedDecision>;
}): { stop: () => void } {
  const onError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      /* Logging cannot become authority. */
    }
  };
  let stopped = false;
  let preparing = false;
  let worker: ReturnType<typeof startSupervisedTaskWorker> | undefined;
  const probe = async () => {
    if (stopped || preparing || isGatewayWorkAdmissionClosed() || (worker && !worker.stopped)) {
      return;
    }
    try {
      // Ordinary installations remain non-creating. The supervise CLI explicitly
      // activates this optional subsystem by admitting its first observer.
      if (!isTaskSupervisionActivated()) {
        return;
      }
      preparing = true;
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
    } finally {
      preparing = false;
    }
  };
  const timer = setInterval(() => void probe(), 5_000);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    worker?.stop();
  };
  void probe();
  return { stop };
}
