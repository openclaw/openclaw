import fs from "node:fs";
import path from "node:path";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveHostExecMemoryLimit } from "./child-memory.js";
import { resolveExecIoDevices } from "./linux-exec-cgroup-device.js";
import {
  AGENT_EXEC_CGROUP_ENV,
  getAgentExecCgroup,
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
export async function initializeGatewayExecCgroup(stateDir: string): Promise<string> {
  delete process.env[AGENT_EXEC_CGROUP_ENV];
  getAgentExecCgroup();
  if (process.platform !== "linux") {
    return "Agent exec cgroup isolation is only available on Linux.";
  }
  let directory: string | undefined;
  try {
    const root = resolveGatewayServiceCgroupDirectory();
    if (
      !root ||
      path.basename(/^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1] ?? "") !==
        "gateway"
    ) {
      throw new Error("requires Delegate=yes and DelegateSubgroup=gateway (systemd 254+)");
    }
    fs.accessSync(path.join(root, "cgroup.subtree_control"), fs.constants.W_OK);
    const { execSystemctl, execSystemctlUser } = await import("../daemon/systemd-exec.js");
    const relative = root.slice(cgroupMount.length);
    const args = ["show", path.basename(root), "--no-page", "--property=Delegate,ControlGroup"];
    const manager = /\/user@\d+\.service\//u.test(relative)
      ? await execSystemctlUser(process.env, args, 5_000)
      : await execSystemctl(args, undefined, 5_000);
    const properties = parseKeyValueOutput(manager.stdout, "=");
    if (
      manager.code !== 0 ||
      manager.termination !== "exit" ||
      properties.delegate !== "yes" ||
      properties.controlgroup !== relative
    ) {
      throw new Error("the running service does not have verified Delegate=yes");
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
    // Retire any earlier policy while configuring; publish the inherited fact only on success.
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
    process.env[AGENT_EXEC_CGROUP_ENV] = directory;
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
