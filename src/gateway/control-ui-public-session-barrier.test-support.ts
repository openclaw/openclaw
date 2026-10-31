import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";

export function publicReadBarrier(signal: AbortSignal) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    enter: () => entered.resolve(),
    async hold() {
      entered.resolve();
      await withinTest(released.promise, signal);
    },
    wait: (reading: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(entered.promise, reading, message), signal),
    release: () => released.resolve(),
  };
}
