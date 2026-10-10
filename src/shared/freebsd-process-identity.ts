import { endianness } from "node:os";
import type { LibraryHandle } from "koffi";
import { loadFreeBsdProcessIdentityNative } from "./freebsd-process-identity-native.ts";

// Retain the library with its callable for this process. Failed loads stay retryable.
let native: { library: LibraryHandle; sysctl: ReturnType<LibraryHandle["func"]> } | undefined;

function getSysctl() {
  if (!native) {
    const library = loadFreeBsdProcessIdentityNative().load(null);
    const sysctl = library.func(
      "int sysctl(const int *name, unsigned int namelen, _Out_ void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)",
    );
    native = { library, sysctl };
  }
  return native.sysctl;
}

function readTimeval(bytes: Buffer, offset: number): bigint {
  const seconds = bytes.readBigInt64LE(offset);
  const microseconds = bytes.readBigInt64LE(offset + 8);
  if (seconds < 0n || microseconds < 0n || microseconds >= 1_000_000n) {
    throw new Error("Invalid FreeBSD process identity timeval");
  }
  return seconds * 1_000_000n + microseconds;
}

/** Read the kernel's monotonic process start time in microseconds. */
export function readFreeBsdProcessStartTime(pid: number): number | null {
  if (
    process.platform !== "freebsd" ||
    (process.arch !== "x64" && process.arch !== "arm64") ||
    endianness() !== "LE" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    pid > 0x7fffffff
  ) {
    return null;
  }
  try {
    const sysctl = getSysctl();
    const bytes = Buffer.alloc(1120);
    // Match libutil/kinfo_getproc.c's numeric MIB: kern.proc.pid is a dynamic
    // NODE that sysctl's CLI and name lookup do not invoke for a selected PID.
    for (const [mib, offset, length] of [
      [[1, 21], 0, 16],
      [[1, 14, 1, pid], 16, 1088],
      [[1, 21], 1104, 16],
    ] as const) {
      const actual = [length];
      if (
        sysctl(mib, mib.length, bytes.subarray(offset, offset + length), actual, null, 0) !== 0 ||
        actual[0] !== length
      ) {
        return null;
      }
    }
    // FreeBSD's 64-bit kinfo_proc ABI is size-preserved. Reject other layouts
    // instead of reading a different field as an ownership identity.
    if (
      bytes.readInt32LE(16) !== 1088 ||
      bytes.readInt32LE(20) !== 0 ||
      bytes.readInt32LE(88) !== pid ||
      !bytes.subarray(0, 16).equals(bytes.subarray(1104))
    ) {
      return null;
    }
    // ki_start includes the mutable boot-time offset. Subtract its exact timeval;
    // reject a changed bracket rather than publish a mixed-clock identity.
    const start = readTimeval(bytes, 352) - readTimeval(bytes, 0);
    return start >= 0n && start <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(start) : null;
  } catch {
    return null;
  }
}
