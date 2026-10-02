import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBunRuntime, resolveRuntimeScriptPosition } from "../daemon/runtime-binary.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { escapeRegExp } from "../shared/regexp.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import {
  classifyOpenClawArgv,
  classifyOpenClawEntrypointPath,
  readProcessPackageIdentity,
  readProcessWorkingDirectories,
  referencesRetainedArtifact,
} from "./gateway-process-argv.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { readWindowsProcessCensus } from "./windows-process-census.js";

const workerEntrypoints = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`src/infra/${entry.sourceWorkerName}.ts`),
  `dist/${entry.distWorkerPath}`,
]);

type ProcessArtifactCustody =
  | { kind: "holder" }
  | { kind: "non-holder" }
  | { kind: "unresolved"; reason: string };

function classifyProcessArtifactCustody(
  command: ProcessCommand | undefined,
  pid: number,
  cwd: string | undefined,
): ProcessArtifactCustody {
  try {
    const argv = command && "argv" in command ? command.argv : [];
    if ([...argv, cwd ?? ""].some(referencesRetainedArtifact)) {
      return { kind: "holder" };
    }
    if (!command) {
      throw new Error("process command is unavailable");
    }
    // The command reader admits these only for observed foreign UIDs or kernel/dead processes.
    if ("argvUnavailable" in command || command.argv.length === 0) {
      return { kind: "non-holder" };
    }
    const { serviceMarker } = command;
    const options = {
      pid,
      cwd: cwd ?? "",
      serviceMarker,
      additionalEntrypoints: workerEntrypoints,
      inspectPackage: true,
    };
    const identity = classifyOpenClawArgv(argv, options);
    if (identity.kind === "openclaw") {
      return { kind: "holder" };
    }
    if (identity.kind === "unclassified" && identity.cause !== "runtime-syntax") {
      throw new Error(identity.reason);
    }
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new Error("working directory is unavailable");
    }
    const { position, operands } = resolveRuntimeScriptPosition(argv);
    if (typeof position !== "number" && position.kind === "not-runtime") {
      return { kind: "non-holder" };
    }
    let scripts: Record<string, unknown> = {};
    if (typeof position !== "number") {
      const pkg = readProcessPackageIdentity(cwd, true);
      if (pkg.name === "openclaw") {
        return { kind: "holder" };
      }
      scripts = pkg.scripts;
    }
    for (const { value, module } of operands) {
      let candidate = value;
      if (module) {
        if (value.startsWith("file:")) {
          candidate = fileURLToPath(value);
        } else if (!path.isAbsolute(value) && !value.startsWith("./") && !value.startsWith("../")) {
          throw new Error("runtime module package identity is unavailable");
        }
      } else if (
        isBunRuntime(argv[0] ?? "") &&
        !/[\\/]/u.test(value) &&
        !path.extname(value) &&
        typeof scripts[value] === "string" &&
        scripts[value].trim()
      ) {
        // Bun package tasks take precedence over a same-named file.
        continue;
      }
      const evidence = classifyOpenClawEntrypointPath(candidate, options);
      if (evidence.kind === "unclassified") {
        throw new Error(evidence.reason);
      }
      if (evidence.kind === "openclaw") {
        return { kind: "holder" };
      }
    }
    return { kind: "non-holder" };
  } catch (error) {
    return { kind: "unresolved", reason: error instanceof Error ? error.message : String(error) };
  }
}

type HandoffReferences = { runId: string; artifactPaths: readonly string[] };
type CensusResult = { matchingPids: number[]; unverifiedPids: number[]; error?: string };
type CensusProcess = { pid: number; state: string; command?: { ppid: number } & ProcessCommand };

/** Default custody decisions stay conservative; reference inspection also reports partial evidence. */
export function inspectOtherOpenClawProcesses(references: HandoffReferences): CensusResult;
export function inspectOtherOpenClawProcesses(): { pids: number[] } | { error: string };
export function inspectOtherOpenClawProcesses(handoff?: HandoffReferences) {
  const result: CensusResult = { matchingPids: [], unverifiedPids: [] };
  try {
    if (process.platform === "linux" && isContainerEnvironment()) {
      throw new Error(
        "Host process visibility cannot be established from this container. Run Doctor on the host after stopping OpenClaw containers that share its temporary directory.",
      );
    }
    const windows = process.platform === "win32";
    const deadline = Date.now() + (handoff ? 15_000 : 1_000);
    const native = windows && handoff ? [...readWindowsProcessCensus(15_000)] : undefined;
    const nativeByPid = new Map(native?.map((entry) => [entry.pid, entry]));
    const processes: CensusProcess[] = native?.map(({ pid, parentPid, commandLine }) => {
      const argv = commandLine ? parseWindowsNativeCommandLine(commandLine) : null;
      return {
        pid,
        state: "",
        command: argv?.length && parentPid !== undefined ? { ppid: parentPid, argv } : undefined,
      };
    }) ?? [
      ...readProcessGroupMembers(handoff ? 15_000 : 1_000, {
        readDarwinCommand: readDarwinProcessCommand,
      }),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const current = byPid.get(process.pid);
    if (
      !current ||
      (!handoff &&
        processes.some(
          (entry) => !entry.command || (process.platform === "linux" && !("argv" in entry.command)),
        ))
    ) {
      throw new Error("OpenClaw process census is incomplete.");
    }
    const directories = native
      ? new Map(native.map(({ pid, cwd }) => [pid, cwd]))
      : readProcessWorkingDirectories(processes.map(({ pid }) => pid));
    const launchers = new Set<number>();
    const ancestors = new Set<number>([process.pid]);
    let child = current;
    let parentPid = current.command?.ppid ?? 0;
    while (parentPid > 0) {
      const parent = byPid.get(parentPid);
      if (!parent?.command || ancestors.has(parentPid)) {
        if (handoff) {
          break;
        }
        throw new Error("OpenClaw process ancestry is incomplete.");
      }
      const parentStart = nativeByPid.get(parentPid)?.startIdentity;
      const childStart = nativeByPid.get(child.pid)?.startIdentity;
      if (windows && (!parentStart || !childStart || BigInt(parentStart) >= BigInt(childStart))) {
        break;
      }
      ancestors.add(parentPid);
      if ("argv" in parent.command) {
        const { argv, serviceMarker } = parent.command;
        const identity = classifyOpenClawArgv(argv, {
          pid: parentPid,
          serviceMarker,
          cwd: directories.get(parentPid) ?? "",
          additionalEntrypoints: workerEntrypoints,
        });
        // Only a verified CLI launcher in this inspector's ancestry is exempt.
        if (
          identity.kind === "openclaw" &&
          identity.entryIndex !== undefined &&
          getRootOptionAwareCommandPath(["node", ...argv.slice(identity.entryIndex)], 1)[0] ===
            (handoff ? "update" : "doctor")
        ) {
          launchers.add(parentPid);
        }
      }
      child = parent;
      parentPid = parent.command.ppid;
    }
    const normalize = (value: string) =>
      windows
        ? value
            .replaceAll("\\", "/")
            .replace(/\/{2,}\?\/UNC\//gi, "//")
            .replace(/\/{2,}\?\//g, "")
            .replace(/\/{2,}/g, "/")
            .toLowerCase()
        : value;
    const paths =
      handoff?.artifactPaths.flatMap((value) => [
        value.replace(/[\\/]+$/, ""),
        pathToFileURL(value, { windows }).href,
      ]) ?? [];
    const literal = (value: string) => escapeRegExp(normalize(value));
    const matches = new RegExp(
      `(?:^|[^\\w-])(?:${literal(handoff?.runId ?? "")}(?=$|[^\\w-])|(?:${paths.map(literal).join("|") || "(?!)"})(?=$|[/\\s"'\x60);,\\]]))`,
    );
    for (const { pid, state, command } of processes) {
      if (handoff && Date.now() >= deadline) {
        throw new Error("Process census deadline exceeded");
      }
      if (pid === process.pid || launchers.has(pid)) {
        continue;
      }
      if ((state?.startsWith("Z") || handoff) && isPidDefinitelyDead(pid)) {
        continue;
      }
      const argv = command && "argv" in command ? command.argv : undefined;
      if (handoff) {
        if (!windows && argv?.length === 0) {
          continue;
        }
        const observation = nativeByPid.get(pid);
        const cwd = directories.get(pid);
        const texts = [...(argv ?? []), observation?.commandLine ?? "", cwd ?? ""];
        if (texts.some((value) => matches.test(normalize(value)))) {
          result.matchingPids.push(pid);
          continue;
        }
        const foreign =
          observation?.foreignOwner ||
          (command?.uid !== undefined &&
            process.getuid?.() !== undefined &&
            command.uid !== process.getuid?.());
        if ((!argv || cwd === undefined) && !foreign) {
          result.unverifiedPids.push(pid);
          if (windows) {
            result.error = "Retry update repair as Administrator using the same Windows account.";
          }
        }
        continue;
      }
      const custody = classifyProcessArtifactCustody(command, pid, directories.get(pid));
      if (custody.kind === "unresolved") {
        throw new Error(`Could not classify PID ${pid}: ${custody.reason}`);
      }
      if (custody.kind === "holder") {
        result.matchingPids.push(pid);
      }
    }
  } catch (error) {
    const pid = /Could not classify PID (\d+):/.exec(error instanceof Error ? error.message : "");
    if (handoff && pid) {
      result.unverifiedPids.push(Number(pid[1]));
    }
    result.error = handoff
      ? "Host process census is incomplete; verify process-inspection permissions and retry update repair."
      : `Could not inspect OpenClaw processes: ${String(error)}`;
  }
  return handoff ? result : result.error ? { error: result.error } : { pids: result.matchingPids };
}
