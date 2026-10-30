import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveHostExecMemoryLimit } from "./child-memory.js";
import { resolveExecIoDevices } from "./linux-exec-cgroup-device.js";

const cgroupMount = "/sys/fs/cgroup";
const budgetKeys = ["rbps", "wbps", "riops", "wiops"] as const;
type IoBudget = Record<(typeof budgetKeys)[number], number>;
const state = resolveGlobalSingleton<{ discovered: boolean; directory: string | undefined }>(
  Symbol.for("openclaw.agentExecCgroup"),
  () => ({
    discovered: false,
    directory: undefined,
  }),
);

function serviceDirectory(): string | undefined {
  const relative = /^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  if (!relative || !/^\/(?:[^/]+\/)*[^/]+\.service\/(?:gateway|agent-exec)$/u.test(relative)) {
    return undefined;
  }
  return path.dirname(path.join(cgroupMount, relative));
}

function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

function ioBudget(root: string, device: string, bytesPerSecond: number): IoBudget {
  const budget = {
    rbps: bytesPerSecond,
    wbps: bytesPerSecond,
    riops: Math.max(1, Math.floor(bytesPerSecond / 4096)),
    wiops: Math.max(1, Math.floor(bytesPerSecond / 4096)),
  };
  for (let ancestor = root; ancestor !== cgroupMount; ancestor = path.dirname(ancestor)) {
    const line = readOptional(path.join(ancestor, "io.max"))
      .split("\n")
      .find((entry) => entry.startsWith(`${device} `));
    for (const field of line?.split(/\s+/u).slice(1) ?? []) {
      const [key, value] = field.split("=");
      for (const dimension of budgetKeys) {
        if (key === dimension && value !== "max" && Number(value) > 0) {
          budget[dimension] = Math.min(
            budget[dimension],
            Math.max(1, Math.floor(Number(value) / 2)),
          );
        }
      }
    }
  }
  return budget;
}

/** One startup owner configures the delegated subtree before admitting exec. */
export function initializeGatewayExecCgroup(stateDir: string): string {
  state.discovered = true;
  state.directory = undefined;
  if (process.platform !== "linux") {
    return "Agent exec cgroup isolation is only available on Linux.";
  }
  let directory: string | undefined;
  try {
    const root = serviceDirectory();
    if (
      !root ||
      path.basename(/^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1] ?? "") !==
        "gateway"
    ) {
      throw new Error("requires Delegate=yes and DelegateSubgroup=gateway (systemd 254+)");
    }
    const controllers = new Set(readOptional(path.join(root, "cgroup.controllers")).split(/\s+/u));
    if (!["cpu", "io", "memory"].every((controller) => controllers.has(controller))) {
      throw new Error("the service has not delegated cpu, io, and memory controllers");
    }
    if (readOptional(path.join(root, "cgroup.procs"))) {
      throw new Error(
        "the service root still contains processes; move its launcher into the gateway leaf",
      );
    }
    const devices = resolveExecIoDevices(stateDir);
    const memoryHigh = resolveHostExecMemoryLimit();
    if (!memoryHigh || !devices.length) {
      throw new Error("the host memory or state-device budget is unavailable");
    }
    fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +io +memory");
    directory = path.join(root, "agent-exec");
    fs.mkdirSync(directory, { recursive: true });
    // memory.high is published last: helpers only discover fully prepared groups.
    fs.writeFileSync(path.join(directory, "memory.high"), "max");
    fs.writeFileSync(path.join(directory, "cpu.weight"), "10");
    // A shared memory-sized IO backlog per five minutes, divided between reads
    // and writes and across backing devices. This is a pressure budget, not an
    // estimate of disk speed. Tighter inherited ceilings retain half for peers.
    const bytesPerSecond = Math.max(1, Math.floor(memoryHigh / 600 / devices.length));
    const limits = devices.map((device) => {
      const budget = ioBudget(root, device, bytesPerSecond);
      const line = `${device} ${budgetKeys.map((key) => `${key}=${budget[key]}`).join(" ")}`;
      fs.writeFileSync(path.join(directory!, "io.max"), line);
      return line;
    });
    fs.writeFileSync(path.join(directory, "memory.high"), String(memoryHigh));
    state.directory = directory;
    return `Agent exec isolation active: cpu.weight=10 memory.high=${memoryHigh}; io.max: ${limits.join("; ")}. Gateway IO is uncapped.`;
  } catch (error) {
    if (directory) {
      try {
        fs.writeFileSync(path.join(directory, "memory.high"), "max");
      } catch {
        // Preserve any surviving process tree; systemd owns final subtree cleanup.
      }
    }
    return `Agent exec isolation unavailable: ${error instanceof Error ? error.message : String(error)}. Continuing without exec isolation; check Gateway service delegation with openclaw doctor.`;
  }
}

/** Kernel state carries the prepared fact into runtime workers and native helpers. */
export function getAgentExecCgroup(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  if (!state.discovered) {
    state.discovered = true;
    try {
      const root = serviceDirectory();
      const directory = root && path.join(root, "agent-exec");
      if (
        directory &&
        Number(readOptional(path.join(directory, "memory.high"))) > 0 &&
        /\brbps=\d+\b/u.test(readOptional(path.join(directory, "io.max")))
      ) {
        state.directory = directory;
      }
    } catch {
      // Startup diagnostics own unavailable delegation; optional isolation never blocks exec.
    }
  }
  return state.directory;
}

/** Dedicated anchors/PTY helpers enter before launching their first application child. */
export function enterAgentExecCgroup(): void {
  const directory = getAgentExecCgroup();
  if (directory) {
    try {
      fs.writeFileSync(path.join(directory, "cgroup.procs"), "0");
    } catch (error) {
      process.emitWarning(`Agent exec cgroup placement failed: ${String(error)}`);
    }
  }
}

/** Only the small broker may move across a synchronous native fork, never the Gateway. */
export function spawnInAgentExecCgroup<T>(directory: string | undefined, spawn: () => T): T {
  if (!directory || process.platform !== "linux") {
    return spawn();
  }
  let moved = false;
  try {
    fs.writeFileSync(path.join(directory, "cgroup.procs"), "0");
    moved = true;
  } catch (error) {
    process.emitWarning(`Agent exec cgroup placement failed: ${String(error)}`);
  }
  try {
    return spawn();
  } finally {
    if (moved) {
      try {
        fs.writeFileSync(path.join(path.dirname(directory), "gateway", "cgroup.procs"), "0");
      } catch (error) {
        // Never lose an already-spawned child handle or its cleanup custody.
        process.emitWarning(
          `Spawn broker could not return to the Gateway cgroup: ${String(error)}`,
        );
      }
    }
  }
}
