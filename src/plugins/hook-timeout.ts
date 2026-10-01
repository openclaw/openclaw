import { trackAsyncWork } from "../shared/async-work-scope.js";

export const withHookTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  optionsResult: { unref?: boolean } = {},
): Promise<T> => {
  // The handler has started. Retain its work without replacing the raced promise
  // if its caller's scope has already closed; hook policy still owns its errors.
  void trackAsyncWork(() => promise).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (optionsResult.unref) {
      timer.unref?.();
    }
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
