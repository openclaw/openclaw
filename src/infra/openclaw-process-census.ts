import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBunRuntime, resolveRuntimeScriptPosition } from "../daemon/runtime-binary.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
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
    const directories = readProcessWorkingDirectories(processes.map(({ pid }) => pid));
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
          cwd: directories.get(parentPid) ?? "",
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
      .filter(({ pid, state, command }): boolean => {
        if (pid === process.pid || launchers.has(pid)) {
          return false;
        }
        if (state.startsWith("Z") && isPidDefinitelyDead(pid)) {
          return false;
        }
        const custody = classifyProcessArtifactCustody(command, pid, directories.get(pid));
        switch (custody.kind) {
          case "holder":
            return true;
          case "non-holder":
            return false;
          case "unresolved":
            throw new Error(`Could not classify PID ${pid}: ${custody.reason}`);
        }
        throw new Error("Unexpected process custody classification");
      })
      .map(({ pid }) => pid);
    return { pids };
  } catch (error) {
    return { error: `Could not inspect OpenClaw processes: ${String(error)}` };
  }
}
