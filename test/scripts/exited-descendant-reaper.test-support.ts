import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Callers have joined the detached fixture's leader, whose session ID equals its PGID.
export function assertFixtureProcessGroupStopped(pgid: number, platform = process.platform) {
  assert(Number.isSafeInteger(pgid) && pgid > 1 && pgid <= 0x7fffffff);
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  if (platform === "linux") {
    // Include every thread: an exited leader can still have live sibling threads.
    const snapshot = spawnSync("ps", ["-s", String(pgid), "-L", "-o", "pgid=,state="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const zombie = new RegExp(`^\\s*${pgid}\\s+Z\\s*$`, "u");
    if (
      !snapshot.error &&
      snapshot.status === 0 &&
      snapshot.signal === null &&
      snapshot.stdout.endsWith("\n") &&
      snapshot.stdout
        .trim()
        .split("\n")
        .every((row) => zombie.test(row))
    ) {
      return;
    }
  }
  // Reaping during the observation can establish absence; failed ps output cannot.
  assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
}

// Adopt exited tooling descendants and keep them unreaped until the command settles.
export const exitedDescendantReaper = `
import ctypes, os, subprocess, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
try:
    result = subprocess.run(sys.argv[1:])
finally:
    reaped = 0
    while True:
        try:
            pid, code = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0 or code != 0:
            raise RuntimeError("tool descendant did not exit successfully")
        reaped += 1
    print("successfully reaped:", reaped)
    if reaped == 0:
        raise RuntimeError("fixture did not retain an exited descendant")
sys.exit(result.returncode)
`;
