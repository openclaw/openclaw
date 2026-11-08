import { spawnSync } from "node:child_process";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessCommand } from "@openclaw/proc-safe/inspect";
import { isBunRuntime, isNodeRuntime } from "../../daemon/runtime-binary.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { ProcessCommand } from "./service-child-group-ownership.js";

let reportedForeignArguments = false;

function isJsRuntime(value: string): boolean {
  return isNodeRuntime(value) || isBunRuntime(value) || path.basename(value) === "tsx";
}

/** Kernel accounting name: the exec basename, which process.title cannot rewrite. */
function readDarwinImageName(pid: number): string | undefined {
  const result = spawnSync("/bin/ps", ["-o", "ucomm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
  });
  return (result.status === 0 && result.stdout.trim()) || undefined;
}

function readCommandWithServiceMarker(pid: number) {
  try {
    return readProcessCommand(pid, { environmentKeys: ["OPENCLAW_SERVICE_MARKER"] });
  } catch (cause) {
    if (!(cause instanceof ProcSafeError) || cause.code !== "incomplete") {
      throw cause;
    }
    // macOS 27 omits envp for hardened executables, and a JS runtime that set
    // process.title (the Gateway, every OpenClaw CLI) leaves no terminated
    // environment on earlier releases. As on Linux, only a JS runtime needs the
    // marker; its argv still classifies, and only a marker decision stays unknown.
    const command = readProcessCommand(pid);
    return command && [command.executable, command.argv[0] ?? ""].some(isJsRuntime)
      ? { ...command, serviceMarkerUnavailable: true as const }
      : command;
  }
}

/** Exact argv, or observed foreign ownership when Darwin denies argument inspection.
 * Callers that never consult the service marker skip the environment: some macOS
 * argument images end without the separator that bounds it. */
export function readDarwinProcessCommand(
  pid: number,
  owner?: "same" | "different" | "unknown",
  options: { serviceMarker?: boolean } = {},
): ProcessCommand | undefined {
  try {
    const command =
      options.serviceMarker === false ? readProcessCommand(pid) : readCommandWithServiceMarker(pid);
    if (!command) {
      return undefined;
    }
    const serviceMarker = command.environment.OPENCLAW_SERVICE_MARKER;
    return {
      argv: [...command.argv],
      executable: command.executable,
      ...(serviceMarker === undefined ? {} : { serviceMarker }),
      ...("serviceMarkerUnavailable" in command ? { serviceMarkerUnavailable: true } : {}),
    };
  } catch (cause) {
    if (!(cause instanceof ProcSafeError)) {
      throw cause;
    }
    if (cause.code === "layout-mismatch" || cause.code === "incomplete") {
      // Darwin redacts the argument image of binaries entitled with
      // com.apple.private.no-read-procargs (mdworker), which then fails the
      // alignment check. Without argv, only a JS runtime or OpenClaw binary can
      // hold OpenClaw artifacts, as on Windows; other images are not custody doubt.
      const image = readDarwinImageName(pid);
      if (image && !isJsRuntime(image) && !/openclaw/iu.test(image)) {
        return { argvUnavailable: true, executable: image, ...(owner ? { owner } : {}) };
      }
      throw cause;
    }
    if (cause.code === "unsupported-platform" && process.platform === "darwin") {
      throw new Error(
        "Cannot inspect Darwin process arguments under Rosetta; run OpenClaw with native arm64 Node.js.",
        { cause },
      );
    }
    if (cause.code !== "access-denied" && cause.code !== "operation-failed") {
      throw cause;
    }
    if (isPidDefinitelyDead(pid)) {
      return undefined;
    }
    if (owner === "different") {
      if (!reportedForeignArguments) {
        reportedForeignArguments = true;
        createSubsystemLogger("process/census").debug(
          "Unreadable Darwin arguments for another UID do not establish capture custody.",
          { pid, code: cause.code },
        );
      }
      return { argvUnavailable: true, owner };
    }
    throw new Error(
      `Could not classify PID ${pid}: cannot inspect Darwin arguments (${cause.code}).`,
      { cause },
    );
  }
}
