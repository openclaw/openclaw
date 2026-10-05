import { spawnSync } from "node:child_process";

/** Keep artifact reads outside the writer process; descriptor close can release its locks. */
export function readSqliteArtifactBytesFromChild(pathname: string): unknown {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const facts = ['', '-wal', '-shm', '-journal'].map(suffix => {
  const file = process.argv[1] + suffix;
  try { const bytes = fs.readFileSync(file); return {suffix, size:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')}; }
  catch(error) { if(error.code === 'ENOENT') return {suffix, missing:true}; throw error; }
});
process.stdout.write(JSON.stringify(facts));
`,
      pathname,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "SQLite artifact observation failed");
  }
  return JSON.parse(result.stdout);
}

type PosixLock = {
  length: number;
  pid: number;
  start: number;
  type: string;
};

// Query from another process: a raw close in the owner releases its POSIX locks.
// Unlike /proc/locks' chunked global listing, F_GETLK queries the specific file.
export function readMainDatabasePosixLocks(pathname: string): PosixLock[] {
  if (process.platform !== "linux") {
    throw new Error("POSIX lock probe requires the Linux struct flock layout");
  }
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, json, os, struct, sys
layout = struct.Struct("hhqqi4x")
request = layout.pack(fcntl.F_WRLCK, os.SEEK_SET, 1073741826, 510, 0)
with open(sys.argv[1], "rb") as database:
    result = layout.unpack(fcntl.fcntl(database.fileno(), fcntl.F_GETLK, request))
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
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "POSIX lock probe failed");
  }
  return JSON.parse(result.stdout) as PosixLock[];
}
