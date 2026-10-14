import { onTestFinished, vi, type Mock } from "vitest";
import { AsyncWorkScope } from "./async-work-scope.js";

let observation: { spy: Mock<AsyncWorkScope["run"]>; subscribers: number } | undefined;

/** Keep the scope observer installed until its last fixture subscriber finishes. */
export function observeAsyncWorkScopeRuns() {
  const current = (observation ??= {
    spy: vi.spyOn(AsyncWorkScope.prototype, "run"),
    subscribers: 0,
  });
  current.subscribers += 1;
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    current.subscribers -= 1;
    if (current.subscribers === 0) {
      current.spy.mockRestore();
      observation = undefined;
    }
  };
  onTestFinished(dispose);
  return {
    startIndex: current.spy.mock.results.length,
    get mock() {
      return current.spy.mock;
    },
    [Symbol.dispose]: dispose,
  };
}
