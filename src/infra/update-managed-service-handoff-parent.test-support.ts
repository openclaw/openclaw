import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";

export async function prepareManagedServiceParentPreloads(params: {
  root: string;
  scriptPath: string;
  statePath: string;
  parentPid: number;
  parentStartIdentity: number;
  logPath: string;
  parentExitTimeoutMs: number;
  stopSettlementPath: string;
  env: NodeJS.ProcessEnv;
  options?: Pick<
    ManagedServiceBoundaryOptions,
    "terminalParentExitProbe" | "expireParentWhileStopPending"
  >;
}): Promise<NodeJS.ProcessEnv> {
  const {
    root,
    scriptPath,
    statePath,
    parentPid,
    parentStartIdentity,
    logPath,
    parentExitTimeoutMs,
    stopSettlementPath,
    options,
  } = params;
  let helperEnv = params.env;
  if (options?.terminalParentExitProbe) {
    const preloadPath = path.join(root, "terminal-parent-exit-preload.cjs");
    await fs.writeFile(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
        const fs = require("node:fs"), children = require("node:child_process");
        const spawn = children.spawn, execFile = children.execFileSync;
        const kill = process.kill, read = fs.readFileSync;
        let parked = false, probes = 0;
        children.spawn = function(command, args, ...rest) {
          const child = spawn.call(this, command, args, ...rest);
          if (command === "launchctl" && args[0] === "bootout") child.once("spawn", () => { parked = true; });
          return child;
        };
        process.kill = function(pid, signal) {
          if (!parked || pid !== ${parentPid} || signal !== 0) return kill.call(this, pid, signal);
          probes += 1;
          if (probes === 2) {
            fs.appendFileSync(${JSON.stringify(logPath)}, "terminal parent exit observed\\n");
            throw Object.assign(new Error("parent exited"), { code: "ESRCH" });
          }
          if (probes > 2) fs.appendFileSync(${JSON.stringify(logPath)}, "parent probed after terminal exit\\n");
          return true;
        };
        fs.readFileSync = function(file, ...args) {
          if (parked && file === ${JSON.stringify(`/proc/${parentPid}/status`)}) return "State:\\tS\\nThreads:\\t1\\n";
          if (parked && file === ${JSON.stringify(`/proc/${parentPid}/stat`)}) return ${JSON.stringify(`${parentPid} (parent) S ${"0 ".repeat(18)}${parentStartIdentity}`)};
          return read.call(this, file, ...args);
        };
        children.execFileSync = function(command, args, ...rest) {
          if (parked && command === "/bin/ps" && args[1] === "lstart=" && args[3] === ${JSON.stringify(String(parentPid))})
            return ${JSON.stringify(new Date(parentStartIdentity * 1000).toUTCString().replace(/ GMT$/, ""))};
          return execFile.call(this, command, args, ...rest);
        };
        require("node:module").syncBuiltinESMExports();
      }`,
    );
    helperEnv = {
      ...helperEnv,
      NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
    };
  }
  if (options?.expireParentWhileStopPending) {
    // Advance only the helper after native dispatch; the stop subprocess keeps real time.
    // Observe close before failure handling as well as terminal cleanup, which may be slower.
    const preloadPath = path.join(root, "parent-expiry-preload.cjs");
    await fs.writeFile(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
        const fs = require("node:fs");
        const children = require("node:child_process");
        const spawn = children.spawn;
        const now = Date.now;
        const append = fs.appendFileSync;
        const kill = process.kill.bind(process);
        let stop;
        let parentKilledWhileStopPending;
        let failedWhileStopPending;
        children.spawn = (command, args, options) => {
          const child = spawn(command, args, options);
          if ((command === "systemctl" && args.includes("stop")) ||
              (command === "launchctl" && args[0] === "bootout")) {
            stop = { pid: child.pid, closed: false, code: null, signal: null };
            child.once("close", (code, signal) => { stop.closed = true; stop.code = code; stop.signal = signal; });
          }
          return child;
        };
        process.kill = (pid, signal) => {
          if (pid === ${parentPid} && signal === "SIGKILL") parentKilledWhileStopPending = stop && !stop.closed;
          return kill(pid, signal);
        };
        Date.now = () => {
          let parked = false;
          try { parked = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")).parked === true; } catch {}
          return now() + (parked ? ${parentExitTimeoutMs + 1} : 0);
        };
        fs.appendFileSync = (pathname, data, ...args) => {
          if (pathname === ${JSON.stringify(logPath)}) {
            if (String(data).includes("managed update activation failed:")) failedWhileStopPending = stop && !stop.closed;
            if (String(data).includes("managed update helper completed code="))
              fs.writeFileSync(${JSON.stringify(stopSettlementPath)}, JSON.stringify({ ...stop, parentKilledWhileStopPending, failedWhileStopPending }));
          }
          return append(pathname, data, ...args);
        };
      }`,
    );
    helperEnv = {
      ...helperEnv,
      NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
    };
  }
  return helperEnv;
}
