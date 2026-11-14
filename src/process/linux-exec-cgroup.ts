import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const cgroupMount = "/sys/fs/cgroup";
const controllers = ["cpu", "io", "memory"];

export type ProcessExecutionIntent = "agent-tool" | "gateway-internal";

/** Startup prepares the shared fallback before publishing an active aggregate policy. */
export function prepareAgentExecCgroupScope(directory: string, scopeKey?: string): string {
  const scope = scopeKey?.trim();
  const leaf = path.join(
    directory,
    scope ? `session-${createHash("sha256").update(scope).digest("hex").slice(0, 32)}` : "unscoped",
  );
  fs.mkdirSync(leaf, { recursive: true });
  // All commands in one session share this ceiling; command cancellation still
  // belongs to its existing process-tree owner. The parent keeps the total budget.
  const aggregateLimits = fs.readFileSync(path.join(directory, "io.max"), "utf8").trim();
  for (const line of aggregateLimits.split("\n")) {
    const [device, ...fields] = line.split(/\s+/u);
    if (!device) {
      continue;
    }
    const limits = fields.map((field) => {
      const [key, value] = field.split("=");
      const limit = Number(value);
      return `${key}=${limit > 0 && Number.isFinite(limit) ? Math.max(1, Math.floor(limit / 2)) : value}`;
    });
    fs.writeFileSync(path.join(leaf, "io.max"), [device, ...limits].join(" "));
  }
  return leaf;
}

/** Delegation is a kernel capability, resolved from this process's own service leaf. */
export function resolveGatewayServiceCgroupDirectory(): string | undefined {
  const relative = /^0::(.+)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  const service =
    relative &&
    /^(\/(?:[^/]+\/)*[^/]+\.service)\/(?:gateway|agent-exec(?:\/(?:session-[a-f0-9]{32}|unscoped))?)$/u.exec(
      relative,
    );
  if (!service) {
    return undefined;
  }
  const root = path.join(cgroupMount, service[1]!);
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
export function getAgentExecCgroup(scopeKey?: string): string | undefined {
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
      const delegated = new Set(
        fs
          .readFileSync(path.join(directory, "cgroup.subtree_control"), "utf8")
          .trim()
          .split(/\s+/u),
      );
      if (!controllers.every((controller) => delegated.has(controller))) {
        // A retained flat policy still caps old helpers until their owner drains them.
        return directory;
      }
      try {
        return prepareAgentExecCgroupScope(directory, scopeKey);
      } catch (error) {
        process.emitWarning(
          `Session exec IO policy unavailable; using the shared exec budget: ${String(error)}`,
        );
        return path.join(directory, "unscoped");
      }
    }
  } catch {
    // Startup diagnostics own unavailable delegation; optional isolation never blocks exec.
  }
  return undefined;
}

/** Dedicated anchors/PTY helpers enter before launching their first application child. */
export function enterAgentExecCgroup(scopeKey?: string): void {
  const directory = getAgentExecCgroup(scopeKey);
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
        const aggregate =
          path.basename(path.dirname(directory)) === "agent-exec"
            ? path.dirname(directory)
            : directory;
        fs.writeFileSync(path.join(path.dirname(aggregate), "gateway", "cgroup.procs"), "0");
      } catch (error) {
        // Never lose an already-spawned child handle or its cleanup custody.
        process.emitWarning(
          `Spawn broker could not return to the Gateway cgroup: ${String(error)}`,
        );
      }
    }
  }
}
