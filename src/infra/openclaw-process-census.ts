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
import { isRosettaTranslatedProcess } from "../shared/rosetta-translation.js";
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
import { readWindowsUserSid } from "./windows-user-sid.js";

const workerEntrypoints = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`src/infra/${entry.sourceWorkerName}.ts`),
  `dist/${entry.distWorkerPath}`,
]);

type ProcessArtifactCustody =
  | { kind: "holder" }
  | { kind: "non-holder" }
  | { kind: "unresolved"; reason: string };

function isStandardSystemdUserManager(command: ProcessCommand | undefined): boolean {
  return (
    command !== undefined &&
    "argv" in command &&
    command.argv.length === 2 &&
    command.argv[1] === "--user" &&
    (command.argv[0] === "/usr/lib/systemd/systemd" || command.argv[0] === "/lib/systemd/systemd")
  );
}

function isStandardSystemdLoginProcess(
  command: ProcessCommand | undefined,
  parentCommand: ProcessCommand | undefined,
  inspectorUid: number | undefined,
): boolean {
  if (
    process.platform !== "linux" ||
    inspectorUid === undefined ||
    command?.uid !== inspectorUid ||
    !("argv" in command)
  ) {
    return false;
  }
  // The manager changes to / before serving, including on reexec. A census
  // during early initialization can miss its inherited cwd, which it does not
  // use for OpenClaw artifacts. PAM's child only settles that login session;
  // require its same-account manager parent, never its process name alone.
  return (
    isStandardSystemdUserManager(command) ||
    (command.argv.length === 1 &&
      command.argv[0] === "(sd-pam)" &&
      parentCommand?.uid === command.uid &&
      isStandardSystemdUserManager(parentCommand))
  );
}

function classifyProcessArtifactCustody(
  command: ProcessCommand | undefined,
  pid: number,
  cwd: string | undefined,
  parentCommand: ProcessCommand | undefined,
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
    const { position, operands } = resolveRuntimeScriptPosition(argv);
    if (!cwd || !path.isAbsolute(cwd)) {
      const inspectorUid = process.getuid?.();
      if (
        cwd === undefined &&
        identity.kind === "other" &&
        typeof position !== "number" &&
        position.kind === "not-runtime" &&
        command.uid !== undefined &&
        inspectorUid !== undefined &&
        (command.uid !== inspectorUid ||
          isStandardSystemdLoginProcess(command, parentCommand, inspectorUid))
      ) {
        return { kind: "non-holder" };
      }
      throw new Error("working directory is unavailable");
    }
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

type HandoffReferences = {
  runId: string;
  artifactPaths: readonly string[];
  windowsUserSid?: string;
  drivers?: readonly { pid: number; startIdentity: string }[];
};
type CensusResult = { matchingPids: number[]; unverifiedPids: number[]; error?: string };
type CensusProcess = { pid: number; state: string; command?: { ppid: number } & ProcessCommand };

function classifyWindowsHandoffAncestry(
  process: ReturnType<typeof readWindowsProcessCensus>[number],
  byPid: ReadonlyMap<number, ReturnType<typeof readWindowsProcessCensus>[number]>,
  drivers: NonNullable<HandoffReferences["drivers"]>,
): "descendant" | "unrelated" | "unknown" {
  const startedAt = process.startIdentity;
  if (
    startedAt &&
    drivers.length &&
    drivers.every(
      ({ startIdentity }) =>
        /^\d+$/.test(startIdentity) && BigInt(startIdentity) > BigInt(startedAt),
    )
  ) {
    return "unrelated";
  }
  const visited = new Set<number>();
  let child = process;
  while (child.startIdentity && !visited.has(child.pid)) {
    const childStart = child.startIdentity;
    visited.add(child.pid);
    if (
      drivers.some(
        ({ pid, startIdentity }) => pid === child.pid && startIdentity === child.startIdentity,
      )
    ) {
      return "descendant";
    }
    const parent = byPid.get(child.parentPid ?? 0);
    const driver = drivers.find(
      ({ pid, startIdentity }) =>
        pid === child.parentPid &&
        /^\d+$/.test(startIdentity) &&
        BigInt(startIdentity) <= BigInt(childStart),
    );
    if (driver) {
      return !parent || parent.startIdentity === driver.startIdentity ? "descendant" : "unknown";
    }
    if (child.parentPid === 0 || child.parentPid === 4) {
      return "unrelated";
    }
    // Persisted Windows identities have millisecond resolution; equal births
    // cannot exclude a child created in the same clock tick.
    if (!parent?.startIdentity || BigInt(parent.startIdentity) > BigInt(child.startIdentity)) {
      break;
    }
    child = parent;
  }
  return "unknown";
}

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
    const sameWindowsUser =
      windows &&
      handoff?.windowsUserSid !== undefined &&
      readWindowsUserSid() === handoff.windowsUserSid;
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
        const ancestry =
          observation &&
          classifyWindowsHandoffAncestry(observation, nativeByPid, handoff.drivers ?? []);
        if (ancestry === "descendant") {
          result.matchingPids.push(pid);
          continue;
        }
        // Handoff spawn never elevates or changes accounts. A denied process
        // cannot be its child when inspecting from the recorded launching SID.
        // Missing intermediate parents still leave surviving work unverified.
        if (ancestry === "unrelated" || (sameWindowsUser && observation?.accessDenied)) {
          continue;
        }
        const inspectorUid = process.getuid?.();
        const foreign =
          observation?.foreignOwner ||
          (command?.uid !== undefined &&
            inspectorUid !== undefined &&
            command.uid !== inspectorUid);
        if (
          (!argv || cwd === undefined) &&
          !foreign &&
          !isStandardSystemdLoginProcess(
            command,
            byPid.get(command?.ppid ?? 0)?.command,
            inspectorUid,
          )
        ) {
          result.unverifiedPids.push(pid);
          if (windows) {
            result.error =
              "Please run update repair as the same Windows account that started the update.";
          }
        }
        continue;
      }
      const custody = classifyProcessArtifactCustody(
        command,
        pid,
        directories.get(pid),
        byPid.get(command?.ppid ?? 0)?.command,
      );
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
    result.error = !handoff
      ? `Could not inspect OpenClaw processes: ${String(error)}`
      : isRosettaTranslatedProcess()
        ? "Host process census is unavailable under Rosetta; run openclaw update repair with native arm64 Node.js."
        : "Host process census is incomplete; verify process-inspection permissions and retry update repair.";
  }
  return handoff ? result : result.error ? { error: result.error } : { pids: result.matchingPids };
}
