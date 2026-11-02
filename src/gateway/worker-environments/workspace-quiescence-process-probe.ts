export const WORKSPACE_QUIESCENCE_PROCESS_PROBE_JS = String.raw`function createProcessProbe() {
  // Share 30s across probes: tolerate multi-second stalls on slow hosts while leaving
  // the node transport's 60s command deadline room to deliver the failure and cleanup.
  const deadline = performance.now() + 30000;
  let warned = false;
  return (args, maxBuffer) => {
    let timeout = 2000;
    for (;;) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        const message = "workspace quiescence process check budget exhausted after 30000 ms; check host load and ps availability";
        process.stderr.write(message + "\n");
        throw Object.assign(new Error(message), { code: "WORKSPACE_PROBE_BUDGET_EXHAUSTED" });
      }
      try {
        // SIGTERM can be ignored; SIGKILL keeps even a stuck probe bounded.
        return require("node:child_process").execFileSync("ps", args, {
          encoding: "utf8", maxBuffer, timeout: Math.min(timeout, remaining), killSignal: "SIGKILL",
        });
      } catch (error) {
        if (!error || error.code !== "ETIMEDOUT") throw error;
        if (!warned) {
          process.stderr.write("workspace quiescence: slow ps check; retrying within the shared 30000 ms budget\n");
          warned = true;
        }
        timeout *= 2;
      }
    }
  };
}`;

export const WORKSPACE_QUIESCENCE_PROCESS_IDENTITY_JS = String.raw`function processIdentity(pid, withState = false) {
  try {
    const output = processProbe(["-o", withState ? "stat=,lstart=" : "lstart=", "-p", String(pid)], 4096).trim();
    if (!withState) return output || null;
    const match = /^(\S+)\s+(.+)$/u.exec(output);
    return match ? { state: match[1], start: match[2] } : null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function reportPendingProcesses(entries, exhausted = false) {
  const pids = entries.filter((entry) => Number.isSafeInteger(entry?.pid) && entry.pid > 0).map((entry) => entry.pid);
  // Match workspaceSyncError's single-line display in the retained diagnostic, while
  // preserving raw ps padding in lease identities used by signal guards and older watchdogs.
  const message = (exhausted
    ? "workspace quiescence recovery exhausted after 4 check passes (30000 ms each, 7000 ms total backoff); check host load and ps availability, then retry workspace recovery; unfinished workers (PID/start): "
    : "workspace quiescence recovery pending PIDs: " + pids.join(", ") + "; unfinished workers (PID/start): ") + JSON.stringify(entries).replace(/\s+/gu, " ");
  process.stderr.write(message + "\n");
  return message;
}`;
