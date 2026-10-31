import fs from "node:fs";
import path from "node:path";

const cgroupMount = "/sys/fs/cgroup";
const controllers = ["cpu", "io", "memory"];

export type ProcessExecutionIntent = "agent-tool" | "gateway-internal";

/** Delegation is a kernel capability, resolved from this process's own service leaf. */
export function resolveGatewayServiceCgroupDirectory(): string | undefined {
  const relative = /^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  if (!relative || !/^\/(?:[^/]+\/)*[^/]+\.service\/(?:gateway|agent-exec)$/u.test(relative)) {
    return undefined;
  }
  const root = path.dirname(path.join(cgroupMount, relative));
  fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK);
  fs.accessSync(path.join(root, "cgroup.subtree_control"), fs.constants.W_OK);
  fs.accessSync(path.join(root, "gateway", "cgroup.procs"), fs.constants.W_OK);
  const available = new Set(
    fs.readFileSync(path.join(root, "cgroup.controllers"), "utf8").trim().split(/\s+/u),
  );
  if (!controllers.every((controller) => available.has(controller))) {
    throw new Error("the service has not delegated cpu, io, and memory controllers");
  }
  if (fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").trim()) {
    throw new Error(
      "the service root still contains processes; move its launcher into the gateway leaf",
    );
  }
  return root;
}

/** Helpers discover the same delegated subtree even with an exact application environment. */
export function getAgentExecCgroup(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const root = resolveGatewayServiceCgroupDirectory();
    if (!root) {
      return undefined;
    }
    const enabled = new Set(
      fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8").trim().split(/\s+/u),
    );
    const directory = path.join(root, "agent-exec");
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
    fs.accessSync(path.join(directory, "cgroup.procs"), fs.constants.W_OK);
    // Startup writes a finite memory.high last, after every controller policy succeeds.
    const memoryHigh = Number(fs.readFileSync(path.join(directory, "memory.high"), "utf8"));
    if (
      controllers.every((controller) => enabled.has(controller)) &&
      memoryHigh > 0 &&
      Number.isFinite(memoryHigh)
    ) {
      return directory;
    }
  } catch {
    // Startup diagnostics own unavailable delegation; optional isolation never blocks exec.
  }
  return undefined;
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
