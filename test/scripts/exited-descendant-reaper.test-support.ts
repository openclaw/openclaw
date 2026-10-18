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
// Adopted exits are recorded, not judged: tsx starts an esbuild service per worker
// thread, and a worker terminated mid-import leaves that service to die by SIGPIPE,
// unreaped until its process exits. Only a descendant still running after the
// command is a tooling failure; it is named by pid, state, comm and argv.
// Keep this source free of JS template escapes: no backslashes or dollar-brace.
export const exitedDescendantReaper = `
import ctypes, os, signal, subprocess, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")

def describe(pid):
    try:
        with open("/proc/%d/stat" % pid) as handle:
            stat = handle.read()
        with open("/proc/%d/cmdline" % pid, "rb") as handle:
            argv = [part.decode(errors="replace") for part in handle.read().split(bytes([0])) if part]
    except OSError:
        return "pid=%d (gone)" % pid
    comm = stat[stat.index("(") + 1 : stat.rindex(")")]
    fields = stat[stat.rindex(")") + 2 :].split()
    return "pid=%d ppid=%s state=%s comm=%s argv=%r" % (pid, fields[1], fields[0], comm, argv)

def running_children():
    rows = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % entry) as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except OSError:
            continue
        if int(fields[1]) == os.getpid() and fields[0] != "Z":
            rows.append(describe(int(entry)))
    return rows

try:
    result = subprocess.run(sys.argv[1:])
finally:
    reaped = []
    while True:
        try:
            # Peek before reaping so a failure can still name the exited descendant.
            info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            break
        if info is None:
            raise RuntimeError(
                "tool descendant was still running after the command exited: "
                + "; ".join(running_children() or ["(no running child found)"])
            )
        detail = describe(info.si_pid)
        os.waitpid(info.si_pid, 0)
        if info.si_code == os.CLD_EXITED:
            reaped.append("exit %d %s" % (info.si_status, detail))
        else:
            reaped.append("signal %s %s" % (signal.Signals(info.si_status).name, detail))
    print("successfully reaped:", len(reaped))
    for detail in reaped:
        print("reaped descendant:", detail)
    if not reaped:
        raise RuntimeError("fixture did not retain an exited descendant")
sys.exit(result.returncode)
`;
