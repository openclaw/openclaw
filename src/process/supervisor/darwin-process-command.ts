import { createRequire } from "node:module";
import path from "node:path";
import { isBunRuntime, isNodeRuntime } from "../../daemon/runtime-binary.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { ProcessCommand } from "./service-child-group-ownership.js";

let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const sysctl = system.func(
    "int sysctl(const int *name, unsigned int namelen, void *oldp, size_t *oldlenp, const void *newp, size_t newlen)",
  );
  const pidPath = koffi
    .load("/usr/lib/libproc.dylib")
    .func("int proc_pidpath(int pid, void *buffer, uint32_t buffersize)");
  const csops = system.func(
    "int csops(int pid, unsigned int ops, void *useraddr, size_t usersize)",
  );
  const size = Buffer.alloc(8);
  const argMax = Buffer.alloc(4);
  size.writeBigUInt64LE(4n);
  if (sysctl(new Int32Array([1, 8]), 2, argMax, size, null, 0) !== 0 || argMax.readInt32LE() <= 4) {
    throw new Error("Darwin process argument limit is unavailable");
  }
  const buffer = Buffer.alloc(argMax.readInt32LE());
  return {
    readArguments(pid: number): { bytes: Buffer } | { errno: number } {
      size.writeBigUInt64LE(BigInt(buffer.length));
      // CTL_KERN/KERN_PROCARGS2 returns argc, executable, NUL padding, then argv.
      if (sysctl(new Int32Array([1, 49, pid]), 3, buffer, size, null, 0) !== 0) {
        return { errno: koffi.errno() };
      }
      const length = Number(size.readBigUInt64LE());
      if (length < 4 || length > buffer.length) {
        throw new Error(`Incomplete Darwin process arguments for PID ${pid}`);
      }
      return { bytes: buffer.subarray(0, length) };
    },
    executable(pid: number): string | undefined {
      const executableBuffer = Buffer.alloc(4096); // PROC_PIDPATHINFO_MAXSIZE
      const length: number = pidPath(pid, executableBuffer, executableBuffer.length);
      const end = executableBuffer.indexOf(0);
      return length > 0 && length <= executableBuffer.length && end > 0
        ? executableBuffer.toString("utf8", 0, end)
        : undefined;
    },
    isPlatformBinary(pid: number): boolean {
      const flags = Buffer.alloc(4);
      // CS_OPS_STATUS must prove both CS_VALID and CS_PLATFORM_BINARY now.
      return (
        csops(pid, 0, flags, flags.length) === 0 &&
        (flags.readUInt32LE() & 0x0400_0001) === 0x0400_0001
      );
    },
  };
}

function parseArguments(bytes: Buffer, pid: number): ProcessCommand {
  const argc = bytes.readInt32LE();
  let offset = bytes.indexOf(0, 4);
  if (argc <= 0 || argc > bytes.length || offset <= 4) {
    throw new Error(`Invalid Darwin process arguments for PID ${pid}`);
  }
  while (offset < bytes.length && bytes[offset] === 0) {
    offset++;
  }
  const argv: string[] = [];
  for (let index = 0; index < argc; index++) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) {
      throw new Error(`Truncated Darwin process arguments for PID ${pid}`);
    }
    argv.push(bytes.toString("utf8", offset, end));
    offset = end + 1;
  }
  // Retain only the service owner's marker; process environments may contain credentials.
  const marker = bytes
    .toString("utf8", offset)
    .split("\0")
    .find((entry) => entry.startsWith("OPENCLAW_SERVICE_MARKER="));
  return {
    argv,
    ...(marker ? { serviceMarker: marker.slice("OPENCLAW_SERVICE_MARKER=".length) } : {}),
  };
}

function isForeignNativeExecutable(executable: string, uid: number): boolean {
  return !(
    uid === process.getuid?.() ||
    isNodeRuntime(executable) ||
    isBunRuntime(executable) ||
    /^openclaw(?:-|$)/i.test(path.basename(executable)) ||
    /\.app(?:\/|$)/i.test(executable) ||
    /\/(?:Python|Ruby|Perl|Tcl|Tk|JavaVM|JavaScriptCore)\.framework\//i.test(executable) ||
    executable.includes("/bin/") ||
    executable.includes("/openclaw-plugin-build-")
  );
}

/** Exact argv, or explicit kernel-executable evidence for a foreign system service. */
export function readDarwinProcessCommand(pid: number, uid?: number): ProcessCommand | undefined {
  native ??= loadNative();
  const result = native.readArguments(pid);
  if ("bytes" in result) {
    return parseArguments(result.bytes, pid);
  }
  if (isPidDefinitelyDead(pid)) {
    return undefined;
  }
  const executable = native.executable(pid);
  if (
    uid !== undefined &&
    executable &&
    isForeignNativeExecutable(executable, uid) &&
    native.isPlatformBinary(pid)
  ) {
    return { argvUnavailable: true, executable, uid };
  }
  throw new Error(
    `Could not classify PID ${pid}: cannot inspect Darwin arguments (errno ${result.errno}).`,
  );
}
