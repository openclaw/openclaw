import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProcessAncestry } from "@openclaw/proc-safe/identity";
import { isBunRuntime, resolveRuntimeScriptPosition } from "../daemon/runtime-binary.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { isPidDefinitelyDead, readLinuxProcessStat } from "../shared/pid-alive.js";
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

function isStandardSystemdUserManager(command: ProcessCommand | undefined): boolean {
  const argv = command && "argv" in command ? command.argv : [];
  return (
    argv.length <= 3 &&
    argv[1] === "--user" &&
    argv.slice(2).every((arg) => /^--deserialize=\d+$/u.test(arg)) &&
    (argv[0] === "/usr/lib/systemd/systemd" || argv[0] === "/lib/systemd/systemd")
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

type ArtifactCustody =
  | { kind: "not-holder" }
  | { kind: "holder"; paths?: string[] }
  | { kind: "unknown"; reason: string };

function classifyProcessArtifactCustody(
  command: ProcessCommand | undefined,
  pid: number,
  cwd: string | undefined,
): ArtifactCustody {
  if (!command) {
    return { kind: "unknown", reason: "process command is unavailable" };
  }
  const argv = "argv" in command ? command.argv : [];
  const references = [
    ...argv.map((value) => value.replace(/^--[^=]+=/u, "").replace(/^-r(?=.)/u, "")),
    cwd ?? "",
    "executable" in command ? (command.executable ?? "") : "",
  ].filter(referencesRetainedArtifact);
  if ("argvUnavailable" in command || argv.length === 0) {
    return references.length ? { kind: "holder" } : { kind: "not-holder" };
  }
  const { position, operands } = resolveRuntimeScriptPosition(argv);
  const options = {
    pid,
    cwd: cwd ?? "",
    serviceMarker: command.serviceMarker,
    additionalEntrypoints: workerEntrypoints,
    inspectPackage: true,
  };
  let unknown: string | undefined;
  const paths = references.flatMap((reference) => {
    const evidence = classifyOpenClawEntrypointPath(reference, options);
    if (evidence.kind === "openclaw" && evidence.artifactPath) {
      return [evidence.artifactPath];
    }
    unknown ??= evidence.kind === "unclassified" ? evidence.reason : "runtime path is unresolved";
    return [];
  });
  if (references.length && operands.length === 0) {
    return unknown ? { kind: "unknown", reason: unknown } : { kind: "holder", paths };
  }
  const identity = classifyOpenClawArgv(argv, options);
  if (identity.kind === "openclaw") {
    if (!identity.artifactPath) {
      return { kind: "holder" };
    }
    paths.push(identity.artifactPath);
  }
  let holder: Extract<ArtifactCustody, { kind: "holder" }> | undefined = paths.length
    ? { kind: "holder", paths }
    : undefined;
  unknown ??=
    identity.kind === "unclassified" && identity.cause !== "runtime-syntax"
      ? identity.reason
      : undefined;
  if (!cwd || !path.isAbsolute(cwd)) {
    // Unrelated commands do not own runtimes merely because cwd is unreadable.
    // Explicit artifact references above still preserve their custody.
    if (
      identity.kind === "other" &&
      typeof position !== "number" &&
      position.kind === "not-runtime" &&
      references.length === 0
    ) {
      return { kind: "not-holder" };
    }
    return { kind: "unknown", reason: unknown ?? "working directory is unavailable" };
  }
  const pkg =
    typeof position !== "number" && position.kind !== "not-runtime"
      ? readProcessPackageIdentity(cwd, true)
      : undefined;
  if (pkg?.kind === "package" && pkg.name === "openclaw") {
    holder = { kind: "holder" };
  }
  const scripts = pkg?.kind === "package" ? pkg.scripts : {};
  if (pkg?.kind === "unknown") {
    unknown ??= pkg.reason;
  }
  for (const { value, module } of operands) {
    let candidate = value;
    if (module) {
      if (value.startsWith("file:")) {
        try {
          candidate = fileURLToPath(value);
        } catch (error) {
          unknown ??= String(error);
          continue;
        }
      } else if (!path.isAbsolute(value) && !value.startsWith("./") && !value.startsWith("../")) {
        unknown ??= "runtime module package identity is unavailable";
        continue;
      }
    } else if (
      isBunRuntime(argv[0] ?? "") &&
      !/[\\/]/u.test(value) &&
      !path.extname(value) &&
      typeof scripts[value] === "string" &&
      scripts[value].trim()
    ) {
      continue;
    }
    const evidence = classifyOpenClawEntrypointPath(candidate, options);
    if (evidence.kind === "unclassified") {
      unknown ??= evidence.reason;
    } else if (evidence.kind === "openclaw") {
      holder =
        evidence.artifactPath && (!holder || holder.paths)
          ? { kind: "holder", paths: [...(holder?.paths ?? []), evidence.artifactPath] }
          : { kind: "holder" };
    }
  }
  return unknown ? { kind: "unknown", reason: unknown } : (holder ?? { kind: "not-holder" });
}

type HandoffReferences = {
  runId: string;
  artifactPaths: readonly string[];
  /** Pre-activation disposal checks only the private stage, not other serving installations. */
  artifactPathsOnly?: true;
  /** Installation and service roots that processes outside the handoff also run from. */
  sharedRoots?: readonly string[];
  /** Epoch ms after which the recorded family starts no work: last activity plus grace. */
  familyDeadline?: number;
  windowsUserSid?: string;
  drivers?: readonly { pid: number; startIdentity: string }[];
  familyExited?: boolean;
};
type CensusResult = {
  matchingPids: number[];
  unverifiedPids: number[];
  warnings?: string[];
  error?: string;
};
type CensusProcess = {
  pid: number;
  ppid?: number;
  state: string;
  command?: { ppid: number } & ProcessCommand;
};

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
    // Recorded parentage survives a replacement in the live PID table.
    if (
      drivers.some(
        ({ pid, startIdentity }) =>
          (pid === child.pid && startIdentity === childStart) ||
          (pid === child.parentPid &&
            /^\d+$/.test(startIdentity) &&
            BigInt(startIdentity) <= BigInt(childStart)),
      )
    ) {
      return "descendant";
    }
    if (child.parentPid === 0 || child.parentPid === 4) {
      return "unrelated";
    }
    const parent = byPid.get(child.parentPid ?? 0);
    // A missing or reused intermediate parent cannot disprove surviving descendants.
    if (!parent?.startIdentity || BigInt(parent.startIdentity) > BigInt(childStart)) {
      break;
    }
    child = parent;
  }
  return "unknown";
}

/** Default custody decisions stay conservative; reference inspection also reports partial evidence. */
export function inspectOtherOpenClawProcesses(references: HandoffReferences): CensusResult;
export function inspectOtherOpenClawProcesses(
  runtimeDirectory?: string,
): { pids: number[]; warnings?: string[] } | { error: string };
export function inspectOtherOpenClawProcesses(references?: HandoffReferences | string) {
  const handoff = typeof references === "object" ? references : undefined;
  const runtimeDirectory = typeof references === "string" ? references : undefined;
  const warnings: string[] = [];
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
        // Handoff matches read argv and cwd only; a launcher needs an argv entrypoint,
        // so the service marker cannot change the outcome. Skip that environment read.
        readDarwinCommand: handoff
          ? (pid, owner) => readDarwinProcessCommand(pid, owner, { serviceMarker: false })
          : readDarwinProcessCommand,
      }),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const current = byPid.get(process.pid);
    if (
      !current ||
      (!handoff &&
        ((!current.command && process.platform !== "darwin") ||
          (process.platform === "linux" &&
            processes.some((entry) => entry.command && !("argv" in entry.command)))))
    ) {
      throw new Error("OpenClaw process census is incomplete.");
    }
    const directories = native
      ? new Map(native.map(({ pid, cwd }) => [pid, cwd]))
      : readProcessWorkingDirectories(processes.map(({ pid }) => pid));
    const launchers = new Set<number>();
    const ancestors = new Set<number>([process.pid]);
    let child = current;
    let parentPid = current.command?.ppid ?? current.ppid ?? 0;
    while (parentPid > 0) {
      const parent = byPid.get(parentPid);
      if (!parent?.command || ancestors.has(parentPid)) {
        // An observed process with unavailable argv remains unknown custody below.
        if (handoff || (parent && !parent.command)) {
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
    const literal = (value: string) => escapeRegExp(normalize(value));
    const referencePattern = (values: readonly string[]) => {
      const paths = values.flatMap((value) => [
        value.replace(/[\\/]+$/, ""),
        pathToFileURL(value, { windows }).href,
      ]);
      return new RegExp(
        `(?:^|[^\\w-])(?:${handoff ? literal(handoff.runId) : "(?!)"}(?=$|[^\\w-])|(?:${paths.map(literal).join("|") || "(?!)"})(?=$|[/\\s"'\x60);,\\]]))`,
      );
    };
    const artifactPaths = handoff?.artifactPaths ?? (runtimeDirectory ? [runtimeDirectory] : []);
    const matches = referencePattern(artifactPaths);
    const rootKey = (value: string) => normalize(value.replace(/[\\/]+$/, ""));
    const sharedRoots = new Set(handoff?.sharedRoots?.map(rootKey));
    const runReferences = referencePattern(
      artifactPaths.filter((value) => !sharedRoots.has(rootKey(value))),
    );
    const inspectorUid = process.getuid?.();
    // Positive start-ordered ancestry proves work is not the handoff family's:
    // this inspector's own descendants, or work whose whole live ancestry began
    // after the family deadline. Missing or unreadable ancestry proves nothing.
    const outsideHandoffFamily = (pid: number, familyDeadline?: number) => {
      let ancestry: ReturnType<typeof readProcessAncestry>;
      try {
        ancestry = readProcessAncestry(pid, { throughPid: process.pid });
      } catch {
        return false;
      }
      if (ancestry?.stoppedBy === "through-pid") {
        return true;
      }
      return (
        familyDeadline !== undefined &&
        ancestry?.stoppedBy === "root" &&
        ancestry.chain.every((member) => {
          const command = byPid.get(member.pid)?.command;
          return (
            member.startTimeMicros > familyDeadline * 1000 ||
            // The user manager adopts orphans like init; it is not work itself.
            (process.platform === "linux" &&
              command?.uid === inspectorUid &&
              isStandardSystemdUserManager(command))
          );
        })
      );
    };
    const predatesHandoffDrivers = (pid: number) => {
      if (process.platform !== "linux" || !handoff?.drivers?.length) {
        return false;
      }
      const startedAt = readLinuxProcessStat(pid)?.startedAt;
      // Protected same-user daemons can hide cwd, but cannot descend from later-born drivers.
      return (
        startedAt !== undefined &&
        handoff.drivers.every(({ startIdentity }) => BigInt(startIdentity) > BigInt(startedAt))
      );
    };
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
        const texts = [
          ...(argv ?? []),
          observation?.commandLine ?? "",
          observation?.executable ?? "",
          cwd ?? "",
        ];
        const identity = classifyOpenClawArgv(argv ?? [observation?.executable ?? ""], {
          pid,
          cwd: cwd ?? "",
          serviceMarker: command && "argv" in command ? command.serviceMarker : undefined,
          additionalEntrypoints: workerEntrypoints,
        });
        if (
          texts.some((value) => matches.test(normalize(value))) ||
          (!handoff.artifactPathsOnly && identity.kind === "openclaw")
        ) {
          // Shared roots and OpenClaw identity also match work started outside the handoff.
          const runReference = texts.some((value) => runReferences.test(normalize(value)));
          if (!outsideHandoffFamily(pid, runReference ? undefined : handoff.familyDeadline)) {
            result.matchingPids.push(pid);
          }
          continue;
        }
        const ancestry = handoff.familyExited
          ? "unrelated"
          : observation &&
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
        const foreign =
          observation?.foreignOwner ||
          command?.owner === "different" ||
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
          ) &&
          !outsideHandoffFamily(pid) &&
          !predatesHandoffDrivers(pid)
        ) {
          result.unverifiedPids.push(pid);
          const image = observation?.executable ?? argv?.[0];
          warnings.push(
            `Could not verify handoff ancestry for PID ${pid} (${image ? (windows ? path.win32 : path).basename(image) : "image unavailable"}).`,
          );
        }
        continue;
      }
      const custody = classifyProcessArtifactCustody(command, pid, directories.get(pid));
      if (custody.kind === "not-holder") {
        continue;
      }
      if (
        custody.kind === "holder" &&
        runtimeDirectory &&
        custody.paths &&
        !custody.paths.some((value) => matches.test(normalize(value)))
      ) {
        continue;
      }
      result.matchingPids.push(pid);
      if (custody.kind === "unknown") {
        warnings.push(`Could not verify runtime custody for PID ${pid}: ${custody.reason}`);
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
  return handoff
    ? { ...result, ...(warnings.length ? { warnings } : {}) }
    : result.error
      ? { error: result.error }
      : {
          pids: result.matchingPids,
          ...(warnings.length ? { warnings } : {}),
        };
}
