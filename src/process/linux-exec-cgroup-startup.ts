import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveExecIoDevices } from "./linux-exec-cgroup-device.js";
import {
  prepareAgentExecCgroupScope,
  resolveGatewayServiceCgroupDirectory,
} from "./linux-exec-cgroup.js";

const cgroupMount = "/sys/fs/cgroup";
const budgetKeys = ["rbps", "wbps", "riops", "wiops"] as const;
type IoBudget = Record<(typeof budgetKeys)[number], number>;

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

function ioBudget(root: string, device: string, budget: IoBudget): IoBudget {
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

function resolveIoLimits(stateDir: string, root: string): string[] {
  // IO sizing retains the original quarter-RAM policy; the larger memory budget
  // must not silently increase a rotational disk's throughput ceiling.
  const constrained = process.constrainedMemory();
  const physical = constrained > 0 ? Math.min(os.totalmem(), constrained) : os.totalmem();
  const ioSizingBytes = Math.max(
    1,
    Math.floor(Math.min(physical / 4, (physical - process.memoryUsage.rss()) / 2)),
  );
  const devices = resolveExecIoDevices(stateDir);
  return devices.map((device) => {
    const nonRotational = readOptional(`/sys/dev/block/${device}/queue/rotational`) === "0";
    // Btrfs measurements (2026-10-31): 250 MiB/s at 40,960 IOPS avoided
    // multi-second Gateway WAL stalls observed at 400 MiB/s.
    const bytesPerSecond = nonRotational
      ? 250 * 1024 ** 2
      : Math.max(1, Math.floor(ioSizingBytes / 600 / devices.length));
    const budget = ioBudget(root, device, {
      rbps: bytesPerSecond,
      wbps: bytesPerSecond,
      riops: nonRotational ? 40_960 : Math.max(1, Math.floor(bytesPerSecond / 4096)),
      wiops: nonRotational ? 40_960 : Math.max(1, Math.floor(bytesPerSecond / 4096)),
    });
    return `${device} ${budgetKeys.map((key) => `${key}=${budget[key]}`).join(" ")}`;
  });
}

/** Keep working delegated IO in its original service envelope; memory uses the sampler. */
function initializeDelegatedExecIo(root: string, limits: string[]): string {
  const leaf = path.join(root, "agent-exec");
  if (readOptional(path.join(leaf, "cgroup.procs"))) {
    return "Existing commands retain their shared exec IO policy; memory protection uses the shared sampler.";
  }
  if (!limits.length) {
    throw new Error("the state-device IO budget is unavailable");
  }
  fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +io +memory");
  fs.mkdirSync(leaf, { recursive: true });
  fs.writeFileSync(path.join(leaf, "memory.high"), "max");
  // Publish the low CPU weight last, after the entire IO hierarchy is ready.
  fs.writeFileSync(path.join(leaf, "cpu.weight"), "100");
  for (const line of limits) {
    fs.writeFileSync(path.join(leaf, "io.max"), line);
  }
  fs.writeFileSync(path.join(leaf, "cgroup.subtree_control"), "+cpu +io +memory");
  prepareAgentExecCgroupScope(leaf);
  fs.writeFileSync(path.join(leaf, "cpu.weight"), "10");
  return `Agent exec IO isolation active: cpu.weight=10; io.max: ${limits.join("; ")}. Each session shares half the aggregate IO ceiling. Memory protection uses the shared sampler.`;
}

/** One startup owner lifts the old throttle and retains delegated IO isolation. */
export async function initializeGatewayExecCgroup(stateDir: string): Promise<string> {
  if (process.platform !== "linux") {
    return "Agent exec cgroup isolation is only available on Linux.";
  }
  let throttleFailure = "";
  try {
    const relative = /^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
    const service = relative && /^(.*\.service)(?:\/.*)?$/u.exec(relative)?.[1];
    const legacy = service && path.join(cgroupMount, service, "agent-exec");
    let existingIo = "";
    const inAgentExec =
      relative === `${service}/agent-exec` || relative?.startsWith(`${service}/agent-exec/`);
    // A test Gateway launched by exec cannot lift its parent's active cache policy.
    if (legacy && !inAgentExec) {
      existingIo = readOptional(path.join(legacy, "io.max"));
      // Lift our former quarter-RAM throttle even when delegation cannot be
      // refreshed. Existing commands and operator memory.max policy stay in place.
      try {
        const high = Number(readOptional(path.join(legacy, "memory.high")));
        if (high > 0 && Number.isFinite(high)) {
          fs.writeFileSync(path.join(legacy, "memory.high"), "max");
        }
      } catch (error) {
        throttleFailure = ` The earlier memory.high throttle could not be removed: ${String(error)}.`;
      }
    }
    const root = resolveGatewayServiceCgroupDirectory();
    if (!root || path.basename(relative ?? "") !== "gateway") {
      throw new Error("requires Delegate=yes and DelegateSubgroup=gateway (systemd 254+)");
    }
    const leaf = path.join(root, "agent-exec");
    try {
      fs.accessSync(leaf, fs.constants.W_OK | fs.constants.X_OK);
      fs.accessSync(path.join(leaf, "cgroup.procs"), fs.constants.W_OK);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    const workingIo =
      /(?:rbps|wbps|riops|wiops)=[1-9]\d*/u.test(existingIo) &&
      readOptional(path.join(leaf, "cpu.weight")) === "10";
    if (workingIo && throttleFailure) {
      return `Agent exec IO isolation active: retaining existing aggregate and session IO policies. Memory protection uses the shared sampler.${throttleFailure}`;
    }
    let limits: string[];
    try {
      limits = resolveIoLimits(stateDir, root);
      if (!limits.length) {
        throw new Error("the state-device IO budget is unavailable");
      }
    } catch (error) {
      if (!workingIo) {
        throw error;
      }
      return `Agent exec IO isolation active: retaining existing aggregate and session IO policies because refresh is unavailable (${String(error)}). Memory protection uses the shared sampler.${throttleFailure}`;
    }
    return `${initializeDelegatedExecIo(root, limits)}${throttleFailure}`;
  } catch (error) {
    return `Agent exec isolation unavailable: ${String(error)}. Continuing with shared sampled memory protection. Check Gateway service delegation with openclaw doctor.${throttleFailure}`;
  }
}
