import { spawnSync } from "node:child_process";

type PosixLock = {
  length: number;
  pid: number;
  start: number;
  type: string;
};

// Query from another process: a raw close in the owner releases its POSIX locks.
// Unlike /proc/locks' chunked global listing, F_GETLK queries the specific file.
export function readMainDatabasePosixLocks(pathname: string): PosixLock[] {
  return readPosixLocks(pathname, 1073741826, 510);
}

export function readSqliteShmPosixLocks(pathname: string): PosixLock[] {
  return readPosixLocks(pathname, 128, 1);
}

function readPosixLocks(pathname: string, start: number, length: number): PosixLock[] {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("POSIX lock probe requires Linux or macOS");
  }
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, json, os, struct, sys
darwin = sys.platform == "darwin"
layout = struct.Struct("qqihh" if darwin else "hhqqi4x")
start, length = int(sys.argv[2]), int(sys.argv[3])
request = layout.pack(start, length, 0, fcntl.F_WRLCK, os.SEEK_SET) if darwin else layout.pack(fcntl.F_WRLCK, os.SEEK_SET, start, length, 0)
with open(sys.argv[1], "rb") as database:
    result = layout.unpack(fcntl.fcntl(database.fileno(), fcntl.F_GETLK, request))
if darwin:
    start, length, pid, lock_type, _ = result
else:
    lock_type, _, start, length, pid = result
locks = [] if lock_type == fcntl.F_UNLCK else [{
    "length": length,
    "pid": pid,
    "start": start,
    "type": "read" if lock_type == fcntl.F_RDLCK else "write",
}]
print(json.dumps(locks))
`,
      pathname,
      String(start),
      String(length),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "POSIX lock probe failed");
  }
  return JSON.parse(result.stdout) as PosixLock[];
}
