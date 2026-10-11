import { channel } from "node:diagnostics_channel";

/** Subscribe only while the worker owner retains resources that pressure can reclaim. */
export function createStateWorkerMemoryPressureSubscription(
  hasCustody: () => boolean,
  retireIdleWorkers: () => void,
) {
  const memoryPressure = channel("openclaw.memory.critical");
  let subscribed = false;
  return () => {
    const required = hasCustody();
    if (required === subscribed) {
      return;
    }
    subscribed = required;
    if (required) {
      memoryPressure.subscribe(retireIdleWorkers);
    } else {
      memoryPressure.unsubscribe(retireIdleWorkers);
    }
  };
}
