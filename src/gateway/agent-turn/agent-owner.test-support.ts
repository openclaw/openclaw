import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

export function createGate() {
  const entered = createDeferred();
  const finish = createDeferred();
  return {
    entered: entered.promise,
    resolve: finish.resolve,
    wait: () => {
      entered.resolve();
      return finish.promise;
    },
  };
}

export function expectCalls(count: number, ...spies: unknown[]) {
  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(count);
  }
}
