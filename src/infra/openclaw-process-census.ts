import path from "node:path";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import { readProcessGroupMembers } from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const workerEntrypoints = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`src/infra/${entry.sourceWorkerName}.ts`),
  `dist/${entry.distWorkerPath}`,
]);

/** Incomplete process inspection never authorizes reclamation of unowned scratch. */
export function inspectOtherOpenClawProcesses(): { pids: number[] } | { error: string } {
  try {
    if (process.platform === "linux" && isContainerEnvironment()) {
      throw new Error(
        "Host process visibility cannot be established from this container. Run Doctor on the host after stopping OpenClaw containers that share its temporary directory.",
      );
    }
    const processes = [
      ...readProcessGroupMembers(1_000, { readDarwinCommand: readDarwinProcessCommand }),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const current = byPid.get(process.pid);
    if (!current?.command || processes.some((entry) => !entry.command)) {
      throw new Error("OpenClaw process census is incomplete.");
    }
    const launchers = new Set<number>();
    const ancestors = new Set<number>([process.pid]);
    let parentPid = current.command.ppid;
    while (parentPid > 0) {
      const parent = byPid.get(parentPid);
      if (!parent?.command || ancestors.has(parentPid)) {
        throw new Error("OpenClaw process ancestry is incomplete.");
      }
      ancestors.add(parentPid);
      if ("argv" in parent.command) {
        const { argv, serviceMarker } = parent.command;
        const identity = classifyOpenClawArgv(argv, {
          pid: parentPid,
          serviceMarker,
          additionalEntrypoints: workerEntrypoints,
        });
        // Only the exact CLI launcher waiting for this Doctor is exempt, never a retitled parent.
        if (
          identity.kind === "openclaw" &&
          identity.entryIndex !== undefined &&
          getRootOptionAwareCommandPath(["node", ...argv.slice(identity.entryIndex)], 1)[0] ===
            "doctor"
        ) {
          launchers.add(parentPid);
        }
      }
      parentPid = parent.command.ppid;
    }
    const pids = processes
      .filter(({ pid, state, command }) => {
        if (pid === process.pid || launchers.has(pid)) {
          return false;
        }
        if (state.startsWith("Z") && isPidDefinitelyDead(pid)) {
          return false;
        }
        if (!command || !("argv" in command)) {
          return false;
        }
        const identity = classifyOpenClawArgv(command.argv, {
          pid,
          serviceMarker: command.serviceMarker,
          additionalEntrypoints: workerEntrypoints,
        });
        if (identity.kind === "unclassified") {
          throw new Error(`Could not classify PID ${pid}: ${identity.reason}`);
        }
        return identity.kind === "openclaw";
      })
      .map(({ pid }) => pid);
    return { pids };
  } catch (error) {
    return { error: `Could not inspect OpenClaw processes: ${String(error)}` };
  }
}
