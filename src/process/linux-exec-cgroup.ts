import fs from "node:fs";
import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const cgroupMount = "/sys/fs/cgroup";
// A startup-owned inherited fact, never an operator configuration override.
export const AGENT_EXEC_CGROUP_ENV = "OPENCLAW_INTERNAL_AGENT_EXEC_CGROUP";
const state = resolveGlobalSingleton<{
  activation: string | undefined;
  directory: string | undefined;
}>(Symbol.for("openclaw.agentExecCgroup"), () => ({
  activation: undefined,
  directory: undefined,
}));

export function resolveGatewayServiceCgroupDirectory(): string | undefined {
  const relative = /^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  if (!relative || !/^\/(?:[^/]+\/)*[^/]+\.service\/(?:gateway|agent-exec)$/u.test(relative)) {
    return undefined;
  }
  return path.dirname(path.join(cgroupMount, relative));
}

/** Helpers inherit only a successfully published startup fact, never stale kernel limits. */
export function getAgentExecCgroup(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const activation = process.env[AGENT_EXEC_CGROUP_ENV];
  if (state.activation !== activation) {
    state.activation = activation;
    state.directory = undefined;
    try {
      const root = activation && resolveGatewayServiceCgroupDirectory();
      if (root && activation === path.join(root, "agent-exec")) {
        state.directory = activation;
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
