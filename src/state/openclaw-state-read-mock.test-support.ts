import {
  createRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import type { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";

type ReadSource = ReturnType<typeof captureOpenClawStateReadSource>;
type ReadTransport = ReturnType<ReadSource["createTransport"]>;

/** Existing asynchronous race fixtures deliberately settle only through their Promise gates. */
export function startAwaitedReadMock<T>(run: () => Promise<T>): RetainedOperation<T> {
  const completion = createRetainedOperation<T>(() => {});
  try {
    void run().then(completion.resolve, completion.reject);
  } catch (error) {
    completion.reject(error);
  }
  return completion.operation;
}

export function createMockStateReadSource(transport: {
  read: (
    ...args: Parameters<ReadTransport["startRead"]>
  ) => ReturnType<ReadTransport["startRead"]>["result"];
  close: () => Promise<void>;
}): ReadSource {
  return {
    own: () => () => {},
    service() {},
    createTransport: () => ({
      startValidateFresh: () => startAwaitedReadMock(async () => {}),
      startRead: (...args) => startAwaitedReadMock(() => transport.read(...args)),
      startClose: () => startAwaitedReadMock(() => transport.close()),
    }),
  };
}
