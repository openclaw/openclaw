import { pathToFileURL } from "node:url";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { escapeRegExp } from "../shared/regexp.js";
import { isContainerEnvironment } from "./container-environment.js";
import { readProcessWorkingDirectories } from "./gateway-process-argv.js";
import { readWindowsProcessCensus } from "./windows-process-census.js";

type CensusProcess = {
  pid: number;
  ppid?: number;
  state: string;
  command?: { ppid: number } & ProcessCommand;
};

export function readCensusSnapshot(referencesOnly: boolean) {
  if (process.platform === "linux" && isContainerEnvironment()) {
    throw new Error(
      "Host process visibility cannot be established from this container. Run Doctor on the host after stopping OpenClaw containers that share its temporary directory.",
    );
  }
  const windows = process.platform === "win32";
  const deadline = Date.now() + (referencesOnly ? 15_000 : 1_000);
  const native = windows ? [...readWindowsProcessCensus(15_000)] : undefined;
  const nativeByPid = new Map(native?.map((entry) => [entry.pid, entry]));
  const processes: CensusProcess[] = native?.map(({ pid, parentPid, commandLine }) => {
    const argv = commandLine ? parseWindowsNativeCommandLine(commandLine) : null;
    return {
      pid,
      state: "",
      command: argv?.length && parentPid !== undefined ? { ppid: parentPid, argv } : undefined,
    };
  }) ?? [
    ...readProcessGroupMembers(referencesOnly ? 15_000 : 1_000, {
      // Handoff matches read argv and cwd only; a launcher needs an argv entrypoint,
      // so the service marker cannot change the outcome. Skip that environment read.
      readDarwinCommand: referencesOnly
        ? (pid, owner) => readDarwinProcessCommand(pid, owner, { serviceMarker: false })
        : readDarwinProcessCommand,
    }),
  ];
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const current = byPid.get(process.pid);
  if (
    !current ||
    (!referencesOnly &&
      ((!current.command && process.platform !== "darwin") ||
        (process.platform === "linux" &&
          processes.some((entry) => entry.command && !("argv" in entry.command)))))
  ) {
    throw new Error("OpenClaw process census is incomplete.");
  }
  const directories = native
    ? new Map(native.map(({ pid, cwd }) => [pid, cwd]))
    : readProcessWorkingDirectories(processes.map(({ pid }) => pid));
  return { windows, deadline, nativeByPid, processes, byPid, current, directories };
}

export function censusReferencePatterns(windows: boolean) {
  const normalize = (value: string) =>
    windows
      ? value
          .replaceAll("\\", "/")
          .replace(/\/{2,}\?\/UNC\//gi, "//")
          .replace(/\/{2,}\?\//g, "")
          .replace(/\/{2,}/g, "/")
          .toLowerCase()
      : value;
  const literal = (value: string) => escapeRegExp(normalize(value));
  const referencePattern = (values: readonly string[], runId?: string) => {
    const paths = values.flatMap((value) => [
      value.replace(/[\\/]+$/, ""),
      pathToFileURL(value, { windows }).href,
    ]);
    return new RegExp(
      `(?:^|[^\\w-])(?:${runId ? literal(runId) : "(?!)"}(?=$|[^\\w-])|(?:${paths.map(literal).join("|") || "(?!)"})(?=$|[/\\s"'\x60);,\\]]))`,
    );
  };
  return { normalize, referencePattern };
}
