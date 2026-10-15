import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exitedDescendantReaper } from "./exited-descendant-reaper.test-support.js";

// The parent hands its child to the reaper without timing: in "signal" mode it waits
// for the child's death without reaping (WNOWAIT), so an exited zombie is adopted.
// A running child exits once neither its parent nor the reaper owns it, leaving no stray.
const orphanParent = `
import os, signal, sys, time
parent, reaper = os.getpid(), os.getppid()
pid = os.fork()
if pid == 0:
    if sys.argv[1] == "signal":
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGPIPE)
    while os.getppid() in (parent, reaper):
        time.sleep(0.01)
    os._exit(0)
if sys.argv[1] == "signal":
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
`;

function reap(mode: "signal" | "running") {
  return spawnSync("python3", ["-c", exitedDescendantReaper, "python3", "-c", orphanParent, mode], {
    encoding: "utf8",
  });
}

describe.runIf(process.platform === "linux")("exited descendant reaper", () => {
  it("records an adopted tool service that died by SIGPIPE without failing", () => {
    // Stands in for an esbuild service left behind by a worker terminated mid-import.
    const result = reap("signal");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/successfully reaped: 1/u);
    expect(result.stdout).toMatch(/reaped descendant: signal SIGPIPE pid=\d+ .*comm=python3/u);
  });

  it("names a descendant still running after the command exits", () => {
    const result = reap("running");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /tool descendant was still running after the command exited: pid=\d+ .*comm=python3 argv=\['python3', '-c'/u,
    );
  });
});
