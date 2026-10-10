import { vi } from "vitest";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import type { AsyncWorkScope } from "../../shared/async-work-scope.js";
import * as agentDelays from "../agent-turn/agent-handler-helpers.js";

/** Retain real fixture work so assertion failures cannot strand it behind a fake clock. */
export function observeCronContinuationLifetime(
  work: AsyncWorkScope,
  joinExecution: () => Promise<void>,
) {
  const waits = new Set<() => void>();
  const recoveries: Promise<unknown>[] = [];
  let closing = false;

  const observeWait = <T>(run: () => T): T => {
    const schedule = globalThis.setTimeout;
    const observation = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        let released = false;
        const release = () => {
          if (released) {
            return;
          }
          released = true;
          waits.delete(release);
          clearTimeout(timer);
          callback(...args);
        };
        const timer = schedule(release, delay);
        waits.add(release);
        if (closing) {
          void Promise.resolve().then(release);
        }
        return timer;
      });
    try {
      return run();
    } finally {
      observation.mockRestore();
    }
  };

  const yieldAfterAck = agentDelays.yieldAfterAgentAcceptedAck;
  const waitForRecovery = agentDelays.waitForCronContinuationReleaseRecovery;
  const continueRootWork = gatewayWork.runWithGatewayIndependentRootWorkContinuation;
  const observations = [
    vi
      .spyOn(agentDelays, "yieldAfterAgentAcceptedAck")
      .mockImplementation(() => observeWait(yieldAfterAck)),
    vi
      .spyOn(agentDelays, "waitForCronContinuationReleaseRecovery")
      .mockImplementation((delay) => observeWait(() => waitForRecovery(delay))),
    vi
      .spyOn(gatewayWork, "runWithGatewayIndependentRootWorkContinuation")
      .mockImplementation((run, origin) => {
        const promise = continueRootWork(run, origin);
        if (origin === "cron:continuation-recovery") {
          recoveries.push(promise);
        }
        return promise;
      }),
  ];

  return {
    work,
    async [Symbol.asyncDispose]() {
      closing = true;
      for (const release of waits) {
        release();
      }
      const failures: unknown[] = [];
      try {
        try {
          await joinExecution();
        } catch (error) {
          failures.push(error);
        }
        for (const outcome of await Promise.allSettled(recoveries)) {
          if (outcome.status === "rejected") {
            failures.push(outcome.reason);
          }
        }
      } finally {
        for (const observation of observations) {
          observation.mockRestore();
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to join cron continuation fixture work");
      }
    },
  };
}
