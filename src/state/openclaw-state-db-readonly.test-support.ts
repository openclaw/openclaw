import {
  createRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";

// These awaited fixtures observe Promise settlement; they do not prove blocked-host progress.
export function observeAsyncFixture<T>(run: () => Promise<T>): RetainedOperation<T> {
  const completion = createRetainedOperation<T>(() => undefined);
  try {
    void run().then(completion.resolve, completion.reject);
  } catch (error) {
    completion.reject(error);
  }
  return completion.operation;
}

// Preparation owns no resource beyond the separately cleaned prepared location.
export function retainFixturePreparation<T>(preparation: RetainedOperation<T>) {
  const close = createRetainedOperation<void>(() => {
    if (preparation.read().status !== "pending") {
      close.resolve(undefined);
    }
  });
  void preparation.result.then(
    () => close.operation.service(),
    () => close.operation.service(),
  );
  return { ...preparation, startClose: () => close.operation };
}

export function createReadWorkerFixture(
  read: (
    source: OpenClawStateReadLocation,
    authority: OpenClawStateReadAuthority,
  ) => Promise<OpenClawStateReadOutcome>,
  close: () => Promise<void>,
) {
  const progress = new Set<() => void>();
  return {
    captureOpenClawStateReadSource: () => ({
      createTransport: () => ({
        startRead: (source: OpenClawStateReadLocation, authority: OpenClawStateReadAuthority) =>
          observeAsyncFixture(() => read(source, authority)),
        startValidateFresh: () => observeAsyncFixture(async () => {}),
        startClose: () => observeAsyncFixture(close),
      }),
      own(service: () => void) {
        progress.add(service);
        return () => progress.delete(service);
      },
      service() {
        for (const service of Array.from(progress)) {
          service();
        }
      },
    }),
  };
}
