import { setTimeout as delay } from "node:timers/promises";
import {
  maybeAdmitSupervisedRootTask,
  type SupervisedRootDisposition,
} from "./supervised-task.admission.js";
import { getSupervisedTask } from "./supervised-task.store.js";
import { startSupervisedTaskWorker } from "./supervised-task.worker.js";

/** Local root commands retain custody until an endpoint. Admission advertises
 * a scoped owner but never lets it touch a task before the input transaction
 * succeeds. An expired owner is replaced, not renewed or mistaken for success. */
export async function runSupervisedForegroundAdmission(
  params: Omit<Parameters<typeof maybeAdmitSupervisedRootTask>[0], "ensureOwner"> & {
    signal?: AbortSignal;
    onError: (error: unknown) => void;
    onHandoff: (result: Exclude<SupervisedRootDisposition, { kind: "ordinary" }>) => Promise<void>;
  },
) {
  let worker: ReturnType<typeof startSupervisedTaskWorker> | undefined;
  let observedFlow: string | undefined;
  let admitted = false;
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  const stop = () => controller.abort(new Error("Local supervision interrupted"));
  const close = () => worker?.stop();
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  const ensureOwner = async (flowId: string) => {
    assertCurrent();
    if (observedFlow && observedFlow !== flowId) {
      throw new Error("Foreground custody cannot switch tasks");
    }
    if (!worker || worker.stopped) {
      const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
        await import("./supervised-task.agent.js");
      await prepareSupervisedAgentRuntime();
      assertCurrent();
      observedFlow = flowId;
      worker = startSupervisedTaskWorker({
        onlyFlowId: flowId,
        canObserve: () => admitted && !signal.aborted,
        runAttempt: runSupervisedAgentAttempt,
        options: params.options,
        onError: params.onError,
      });
    }
    return worker.ownerId;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal.addEventListener("abort", close, { once: true });
  try {
    const result = await maybeAdmitSupervisedRootTask({ ...params, ensureOwner, assertCurrent });
    if (result.kind === "ordinary") {
      return { result };
    }
    // The task receipt is already durable. If source presentation fails, do
    // not run the original request as an ordinary turn or undo accepted input.
    await params.onHandoff(result);
    assertCurrent();
    const followsTask =
      result.kind === "admitted" || result.control === "resume" || observedFlow !== undefined;
    if (!followsTask || !result.flowId) {
      return { result };
    }
    for (;;) {
      assertCurrent();
      const task = getSupervisedTask(result.flowId, params.options);
      if (!task || task.episode !== result.episode) {
        throw new Error("Foreground task episode changed; inspect its current status");
      }
      if (task.endpoint) {
        return { result, task };
      }
      await ensureOwner(result.flowId);
      admitted = true;
      await delay(250, undefined, { signal });
    }
  } finally {
    signal.removeEventListener("abort", close);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    worker?.stop();
  }
}
