import { createRequire } from "node:module";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { ProcessCommand } from "./service-child-group-ownership.js";

let native: ReturnType<typeof loadNative> | undefined;
let reportedForeignArguments = false;

function loadNative() {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const sysctl = system.func(
    "int sysctl(const int *name, unsigned int namelen, void *oldp, size_t *oldlenp, const void *newp, size_t newlen)",
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

/** Exact argv, or observed foreign ownership when Darwin denies argument inspection. */
export function readDarwinProcessCommand(pid: number, uid?: number): ProcessCommand | undefined {
  native ??= loadNative();
  const result = native.readArguments(pid);
  if ("bytes" in result) {
    return parseArguments(result.bytes, pid);
  }
  if (isPidDefinitelyDead(pid)) {
    return undefined;
  }
  const currentUid = process.getuid?.();
  if (uid !== undefined && currentUid !== undefined && uid !== currentUid) {
    if (!reportedForeignArguments) {
      reportedForeignArguments = true;
      createSubsystemLogger("process/census").debug(
        "Unreadable Darwin arguments for another UID do not establish capture custody.",
        { pid, uid, errno: result.errno },
      );
    }
    return { argvUnavailable: true, uid };
  }
  throw new Error(
    `Could not classify PID ${pid}: cannot inspect Darwin arguments (errno ${result.errno}).`,
  );
}
