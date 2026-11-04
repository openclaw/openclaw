import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessCommand } from "@openclaw/proc-safe/inspect";
import { isBunRuntime, isNodeRuntime } from "../../daemon/runtime-binary.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { ProcessCommand } from "./service-child-group-ownership.js";

let reportedForeignArguments = false;

function readCommandWithServiceMarker(pid: number) {
  try {
    return readProcessCommand(pid, { environmentKeys: ["OPENCLAW_SERVICE_MARKER"] });
  } catch (cause) {
    if (!(cause instanceof ProcSafeError) || cause.code !== "incomplete") {
      throw cause;
    }
    // macOS 27 omits envp for hardened executables, including /bin/zsh children
    // that inherited the marker. As on Linux, only a JS runtime needs the marker
    // to classify; its unreadable environment stays unknown custody.
    const command = readProcessCommand(pid);
    if (
      command &&
      [command.executable, command.argv[0] ?? ""].some(
        (value) => isNodeRuntime(value) || isBunRuntime(value) || path.basename(value) === "tsx",
      )
    ) {
      throw cause;
    }
    return command;
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
    };
  } catch (cause) {
    if (!(cause instanceof ProcSafeError)) {
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
