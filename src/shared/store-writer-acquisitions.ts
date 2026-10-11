import { AsyncLocalStorage } from "node:async_hooks";

/** Acquire idle writers synchronously without nesting the acquisition stack. */
export function runStoreWriterAcquisitions<T>(
  acquire: (index: number, next: () => Promise<T>) => Promise<T>,
): Promise<T> {
  let acquiring = false;
  let nextAcquisition: (() => void) | undefined;

  function enqueue(index: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A resumed acquisition must retain its caller's held locks and authority.
      nextAcquisition = AsyncLocalStorage.bind(() => {
        try {
          void acquire(index, () => enqueue(index + 1)).then(resolve, reject);
        } catch (error) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the acquiring owner's rejection value.
          reject(error);
        }
      });
      if (acquiring) {
        return;
      }
      acquiring = true;
      try {
        while (nextAcquisition) {
          const next = nextAcquisition;
          nextAcquisition = undefined;
          next();
        }
      } finally {
        acquiring = false;
      }
    });
  }

  return enqueue(0);
}
