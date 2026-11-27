import { channel } from "node:diagnostics_channel";

const memoryPressure = channel("openclaw.memory.critical");

/** Subscribe only while the worker owner retains resources that pressure can reclaim. */
export function createStateWorkerMemoryPressureSubscription(
  hasCustody: () => boolean,
  retireIdleWorkers: (critical: boolean) => void,
) {
  let subscribed = false;
  const onPressure = (critical: unknown) => retireIdleWorkers(critical === true);
  return () => {
    const required = hasCustody();
    if (required === subscribed) {
      return;
    }
    subscribed = required;
    if (required) {
      memoryPressure.subscribe(onPressure);
    } else {
      memoryPressure.unsubscribe(onPressure);
    }
  };
}
