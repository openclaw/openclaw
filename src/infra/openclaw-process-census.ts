import path from "node:path";
import { isLegacyPluginSourceCaptureName } from "../plugins/plugin-source-capture-path.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import { readProcessGroupMembers } from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import { isOpenClawArgv } from "./gateway-process-argv.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const workerSuffixes = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`/infra/${entry.sourceWorkerName}.ts`),
  `/${entry.distWorkerPath}`,
]);

function isDoctorLauncher(argv: string[]): boolean {
  // A parent wrapper waiting for this exact Doctor is safe; other commands and
  // retitled parents may retain plugin captures of their own.
  const entry = argv.findIndex((arg) => isOpenClawArgv([arg]));
  return (
    entry >= 0 && getRootOptionAwareCommandPath(["node", ...argv.slice(entry)], 1)[0] === "doctor"
  );
}

function isOpenClawProcess(argv: string[]): boolean {
  const executable = (argv[0] ?? "").replaceAll("\\", "/");
  return (
    isOpenClawArgv(argv) ||
    /^openclaw-[a-z0-9-]+$/i.test(executable.split("/").at(-1) ?? "") ||
    argv.some((arg) =>
      arg.replaceAll("\\", "/").split("/").some(isLegacyPluginSourceCaptureName),
    ) ||
    argv.some((arg) => workerSuffixes.some((suffix) => arg.replaceAll("\\", "/").endsWith(suffix)))
  );
}

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
      if ("argv" in parent.command && isDoctorLauncher(parent.command.argv)) {
        launchers.add(parentPid);
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
        return command && "argv" in command ? isOpenClawProcess(command.argv) : false;
      })
      .map(({ pid }) => pid);
    return { pids };
  } catch (error) {
    return { error: `Could not inspect OpenClaw processes: ${String(error)}` };
  }
}
