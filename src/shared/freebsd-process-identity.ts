import { loadFreeBsdProcessIdentityNative } from "./freebsd-process-identity-native.ts";

/** Read the kernel's monotonic process start time in microseconds. */
export function readFreeBsdProcessStartTime(pid: number): number | null {
  if (process.platform !== "freebsd" || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    return null;
  }
  try {
    // Released leases store ki_start minus the bracketed boot timeval, in exact
    // microseconds. Epoch time is not interchangeable with that persisted value.
    return (
      loadFreeBsdProcessIdentityNative().readProcessIdentity(pid)?.startTimeSinceBootMicros ?? null
    );
  } catch {
    return null;
  }
}
