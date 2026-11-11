/** Completion cannot release an operation while a borrowed producer is still running. */
export function createReplyOperationExecutionCustody() {
  let retained = 0;
  let completed = false;
  let pending: (() => void) | undefined;
  const flush = () => {
    if (!retained && pending && !completed) {
      const complete = pending;
      pending = undefined;
      completed = true;
      complete();
    }
  };
  return {
    retain(this: void) {
      if (completed) {
        throw new Error("Cannot borrow execution from a completed session operation");
      }
      retained++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          retained--;
          flush();
        }
      };
    },
    completeWhenReleased(complete: () => void) {
      if (!completed) {
        pending ??= complete;
        flush();
      }
    },
  };
}
