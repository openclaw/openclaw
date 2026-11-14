import {
  configureFsSafeNative,
  getFsSafeNativeConfig,
  type FsSafeNativeMode,
} from "@openclaw/fs-safe/config";

/** WorkerTaskPool serves one task at a time; restore policy after its cleanup settles. */
export async function withWorkerFsSafeNativeMode<T>(
  mode: FsSafeNativeMode,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = getFsSafeNativeConfig();
  configureFsSafeNative({ mode });
  try {
    return await operation();
  } finally {
    configureFsSafeNative(previous);
  }
}
