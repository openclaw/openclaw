import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { sleep } from "../utils/sleep.js";
import { getHostExecMemoryBudget } from "./child-memory.js";

declare const WORKER_DEPLOY_BUILD: boolean;

const cgroupMount = "/sys/fs/cgroup";
const controllers = ["cpu", "io", "memory"];

type ExecCgroupPolicy = { directory: string; sessions: boolean };
let service: {
  resolved?: boolean;
  root?: string;
  relative?: string;
  policy?: ExecCgroupPolicy | null;
  budget?: { bytes: number; applied: Promise<void> };
} = {};

/** Only the startup owner reloads delegation and the policy it may rewrite. */
export function reloadGatewayExecCgroup(): void {
  service = {};
}

export type ProcessExecutionIntent = "agent-tool" | "gateway-internal";

function sessionExecCgroup(directory: string, scopeKey: string): string {
  return path.join(
    directory,
    `session-${createHash("sha256").update(scopeKey).digest("hex").slice(0, 32)}`,
  );
}

/** A sealed provider Sandbox owns its worker tools; Gateway commands keep the host budget. */
export function usesAgentExecHostMemoryBudget(input: {
  executionIntent?: ProcessExecutionIntent;
  cleanupOwnership?: "external";
  workerMemoryBoundary?: "sandbox";
}): boolean {
  return (
    process.platform === "linux" &&
    input.executionIntent === "agent-tool" &&
    input.cleanupOwnership !== "external" &&
    !(
      typeof WORKER_DEPLOY_BUILD === "boolean" &&
      WORKER_DEPLOY_BUILD &&
      input.workerMemoryBoundary === "sandbox"
    )
  );
}

/** Startup prepares the shared fallback before publishing an active aggregate policy. */
export function prepareAgentExecCgroupScope(directory: string, scopeKey?: string): string {
  const scope = scopeKey?.trim();
  return prepareAgentExecCgroupDirectory(
    scope ? sessionExecCgroup(directory, scope) : path.join(directory, "unscoped"),
  );
}

function prepareAgentExecCgroupDirectory(leaf: string): string {
  fs.mkdirSync(leaf, { recursive: true });
  // All commands in one session share this ceiling; command cancellation still
  // belongs to its existing process-tree owner. The parent keeps the total budget.
  const aggregateLimits = fs.readFileSync(path.join(path.dirname(leaf), "io.max"), "utf8").trim();
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

function joinAgentExecCgroup(directory: string): void {
  try {
    fs.writeFileSync(path.join(directory, "cgroup.procs"), "0");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT") || !path.basename(directory).startsWith("session-")) {
      throw error;
    }
    // Teardown can remove an empty leaf after preparation but before this join.
    prepareAgentExecCgroupDirectory(directory);
    fs.writeFileSync(path.join(directory, "cgroup.procs"), "0");
  }
}

let execCgroupCleanup = Promise.resolve();
const sessionLeaf = /^session-[a-f0-9]{32}$/u;
const sessionWatchers = new Map<string, fs.FSWatcher>();
const watcherEvents = new Set<string>();
let watcherBatch: NodeJS.Immediate | undefined;
let sweepAfter = "";
let cleanupLifetime:
  | {
      signal: AbortSignal;
      log: { info: (message: string) => void };
    }
  | undefined;

/** The Gateway owns notifications; housekeeping never holds up process extinction. */
export function startAgentExecCgroupCleanup(
  signal: AbortSignal,
  log: { info: (message: string) => void },
): void {
  cleanupLifetime = { signal, log };
  sweepAfter = "";
  const stop = () => {
    for (const watcher of sessionWatchers.values()) {
      watcher.close();
    }
    sessionWatchers.clear();
    watcherEvents.clear();
    clearImmediate(watcherBatch);
    watcherBatch = undefined;
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    stop();
  }
}

function unwatchSessionCgroup(directory: string): void {
  sessionWatchers.get(directory)?.close();
  sessionWatchers.delete(directory);
  watcherEvents.delete(directory);
}

function watchSessionCgroup(directory: string): void {
  if (sessionWatchers.has(directory) || sessionWatchers.size >= 256) {
    return;
  }
  const watcher = fs.watch(path.join(directory, "cgroup.events"), { persistent: false }, () => {
    watcherEvents.add(directory);
    watcherBatch ??= setImmediate(() => {
      watcherBatch = undefined;
      const directories = [...watcherEvents];
      watcherEvents.clear();
      void enqueueCgroupCleanup(directories, "watcher");
    });
  });
  sessionWatchers.set(directory, watcher);
  watcher.on("error", (error) => {
    unwatchSessionCgroup(directory);
    if (!hasErrnoCode(error, "ENOENT")) {
      process.emitWarning(`Agent exec cgroup watcher failed: ${String(error)}`);
    }
  });
}

function enqueueCgroupCleanup(
  directories: string[],
  source: "completion" | "watcher" | "sweep",
): Promise<void> {
  execCgroupCleanup = execCgroupCleanup.then(async () => {
    const counts = { reclaimed: 0, removed: 0, skippedPopulated: 0, errors: 0 };
    for (const directory of directories) {
      if (cleanupLifetime?.signal.aborted) {
        break;
      }
      try {
        // Subscribe before reading: an exit between the read and watch must not be lost.
        try {
          watchSessionCgroup(directory);
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            counts.errors++;
            process.emitWarning(`Agent exec cgroup watcher unavailable: ${String(error)}`);
          }
        }
        const events = await fs.promises.readFile(path.join(directory, "cgroup.events"), "utf8");
        if (
          !/^populated 0$/mu.test(events) ||
          (await fs.promises.readFile(path.join(directory, "cgroup.procs"), "utf8")).trim()
        ) {
          counts.skippedPopulated++;
          continue;
        }
        // The budget bounds retries, not one uninterruptible kernel reclaim write.
        const deadline = performance.now() + 250;
        let reclaimed = false;
        do {
          const current = (
            await fs.promises.readFile(path.join(directory, "memory.current"), "utf8")
          ).trim();
          if (Number(current) <= 1024 ** 2) {
            break;
          }
          try {
            await fs.promises.writeFile(path.join(directory, "memory.reclaim"), current, {
              flag: fs.constants.O_WRONLY,
            });
            reclaimed = true;
          } catch (error) {
            if (hasErrnoCode(error, "ENOENT")) {
              process.emitWarning(
                "Agent exec memory.reclaim unavailable; removing the empty session cgroup without reclaiming its cache.",
              );
              break;
            }
            if (!hasErrnoCode(error, "EAGAIN")) {
              throw error;
            }
          }
          await sleep(50);
        } while (!cleanupLifetime?.signal.aborted && performance.now() < deadline);
        if (reclaimed) {
          counts.reclaimed++;
        }
        if (cleanupLifetime?.signal.aborted) {
          break;
        }
        // A new arrival leaves the watch armed; its later exit retries cleanup.
        await fs.promises.rmdir(directory);
        counts.removed++;
        unwatchSessionCgroup(directory);
      } catch (error) {
        if (hasErrnoCode(error, "EBUSY") || hasErrnoCode(error, "ENOTEMPTY")) {
          counts.skippedPopulated++;
        } else {
          unwatchSessionCgroup(directory);
          if (!hasErrnoCode(error, "ENOENT")) {
            counts.errors++;
            process.emitWarning(`Agent exec cgroup cleanup failed: ${String(error)}`);
          }
        }
      }
    }
    cleanupLifetime?.log.info(
      `agent exec cgroup cleanup: source=${source} reclaimed=${counts.reclaimed} removed=${counts.removed} skippedPopulated=${counts.skippedPopulated} errors=${counts.errors} watching=${sessionWatchers.size}`,
    );
  });
  return execCgroupCleanup;
}

/** Reclaim before rmdir: removal alone leaves the cache charged to the parent. */
export function reclaimAgentExecCgroup(directory: string | undefined): Promise<void> {
  if (process.platform !== "linux" || !directory || !sessionLeaf.test(path.basename(directory))) {
    return Promise.resolve();
  }
  return enqueueCgroupCleanup([directory], "completion");
}

/** One shallow read, at most 256 leaves; rotate so live leaves cannot starve leftovers. */
export async function sweepAgentExecCgroups(): Promise<void> {
  if (process.platform !== "linux" || cleanupLifetime?.signal.aborted) {
    return;
  }
  try {
    // A Gateway started inside an exec leaf does not own its parent service.
    const root = resolveGatewayServiceCgroupDirectory();
    if (!service.relative?.endsWith(".service/gateway")) {
      return;
    }
    if (!root) {
      return;
    }
    const aggregate = path.join(root, "agent-exec");
    const names = (await fs.promises.readdir(aggregate))
      .filter((name) => sessionLeaf.test(name))
      .toSorted();
    const start = Math.max(
      0,
      names.findIndex((name) => name > sweepAfter),
    );
    const selected = names.slice(start, start + 256);
    sweepAfter = start + selected.length < names.length ? selected.at(-1)! : "";
    await enqueueCgroupCleanup(
      selected.map((name) => path.join(aggregate, name)),
      "sweep",
    );
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      process.emitWarning(`Agent exec cgroup sweep failed: ${String(error)}`);
      cleanupLifetime?.log.info(
        "agent exec cgroup cleanup: source=sweep reclaimed=0 removed=0 skippedPopulated=0 errors=1",
      );
    }
  }
}

/** Helpers enter in their own process; their outside owner retires the session leaf. */
export async function releaseAgentExecCgroupScope(scopeKey?: string): Promise<void> {
  const scope = scopeKey?.trim();
  if (process.platform !== "linux" || !scope) {
    return;
  }
  try {
    const root = resolveGatewayServiceCgroupDirectory();
    if (root) {
      await reclaimAgentExecCgroup(sessionExecCgroup(path.join(root, "agent-exec"), scope));
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      process.emitWarning(`Agent exec cgroup cleanup failed: ${String(error)}`);
    }
  }
}

/** Delegation is a kernel capability, resolved from this process's own service leaf. */
export function resolveGatewayServiceCgroupDirectory(): string | undefined {
  if (service.resolved) {
    return service.root;
  }
  // Cache absence and failures too; optional isolation is retried only by its owner.
  service.resolved = true;
  const relative = (service.relative = /^0::(.+)$/mu.exec(
    fs.readFileSync("/proc/self/cgroup", "utf8"),
  )?.[1]);
  const match =
    relative &&
    /^(\/(?:[^/]+\/)*[^/]+\.service)\/(?:gateway|agent-exec(?:\/(?:session-[a-f0-9]{32}|unscoped))?)$/u.exec(
      relative,
    );
  if (!match) {
    return undefined;
  }
  const root = path.join(cgroupMount, match[1]!);
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
  return (service.root = root);
}

/** Bound ordinary file cache without adding another command-cancellation owner. */
export async function applyAgentExecMemoryBudget(): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  try {
    const root = resolveGatewayServiceCgroupDirectory();
    // A nested Gateway or helper must not resize its parent's budget.
    if (!root || service.relative !== `${root.slice(cgroupMount.length)}/gateway`) {
      return;
    }
    const policy = resolveAgentExecCgroupPolicy();
    if (!policy) {
      return;
    }
    const budget = getHostExecMemoryBudget();
    if (!budget) {
      return;
    }
    const state = service;
    if (state.budget?.bytes !== budget.memoryBytes) {
      // O_NONBLOCK skips writer-side reclaim on recent kernels; async I/O keeps
      // older kernels off the event loop. Concurrent starts await the same write.
      const applied = fs.promises
        .writeFile(path.join(policy.directory, "memory.high"), String(budget.memoryBytes), {
          flag: fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
        })
        .catch((error: unknown) => {
          state.budget = undefined;
          throw error;
        });
      state.budget = { bytes: budget.memoryBytes, applied };
    }
    await state.budget.applied;
  } catch (error) {
    process.emitWarning(
      `Agent exec cache protection unavailable; continuing with shared sampled memory protection: ${String(error)}`,
    );
  }
}

function resolveAgentExecCgroupPolicy(): ExecCgroupPolicy | null {
  if (service.policy !== undefined) {
    return service.policy;
  }
  service.policy = null;
  try {
    const root = resolveGatewayServiceCgroupDirectory();
    if (!root) {
      return null;
    }
    const enabled = new Set(
      fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8").trim().split(/\s+/u),
    );
    const directory = path.join(root, "agent-exec");
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
    fs.accessSync(path.join(directory, "cgroup.procs"), fs.constants.W_OK);
    // Delegation retains IO policy; the shared sampler owns command cancellation.
    const ioPolicy = fs.readFileSync(path.join(directory, "io.max"), "utf8").trim();
    const cpuWeight = fs.readFileSync(path.join(directory, "cpu.weight"), "utf8").trim();
    if (
      controllers.every((controller) => enabled.has(controller)) &&
      ioPolicy &&
      cpuWeight === "10"
    ) {
      const delegated = new Set(
        fs
          .readFileSync(path.join(directory, "cgroup.subtree_control"), "utf8")
          .trim()
          .split(/\s+/u),
      );
      service.policy = {
        directory,
        sessions: controllers.every((controller) => delegated.has(controller)),
      };
    }
  } catch {
    // Startup diagnostics own unavailable delegation; optional isolation never blocks exec.
  }
  return service.policy;
}

/** Helpers discover the same delegated subtree even with an exact application environment. */
export function getAgentExecCgroup(scopeKey?: string): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const policy = resolveAgentExecCgroupPolicy();
  if (!policy) {
    return undefined;
  }
  const { directory, sessions } = policy;
  // A retained flat policy still caps old helpers until their owner drains them.
  if (!sessions) {
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

/** Dedicated anchors/PTY helpers enter before launching their first application child. */
export function enterAgentExecCgroup(scopeKey?: string): void {
  const directory = getAgentExecCgroup(scopeKey);
  if (directory) {
    try {
      joinAgentExecCgroup(directory);
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
    joinAgentExecCgroup(directory);
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
