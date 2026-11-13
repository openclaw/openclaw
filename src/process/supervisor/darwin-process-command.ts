import { spawnSync } from "node:child_process";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { readProcessCommand } from "@openclaw/proc-safe/inspect";
import { isBunRuntime, isNodeRuntime } from "../../daemon/runtime-binary.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type { ProcessCommand } from "./service-child-group-ownership.js";

let reportedForeignArguments = false;

// codesign prints a key/value dump by default and XML with --xml; some macOS 27
// hosts reject the XML form for this blob, so accept either representation.
const REDACTED_ARGUMENTS_ENTITLEMENT =
  /\[Key\] com\.apple\.private\.no-read-procargs\s*\[Value\]\s*\[Bool\] true|<key>com\.apple\.private\.no-read-procargs<\/key>\s*<true\/>/u;

/** The running image: the first text mapping, confirmed by the kernel accounting
 * name (exec basename, truncated to 16 bytes), so a mapped binary cannot pose as it. */
function readDarwinImagePath(pid: number): string | undefined {
  const options = { encoding: "utf8", timeout: 2_000 } as const;
  const mapping = spawnSync(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    options,
  );
  const image = mapping.status === 0 ? /^n(\/.+)$/mu.exec(mapping.stdout)?.[1] : undefined;
  const name = image && spawnSync("/bin/ps", ["-o", "ucomm=", "-p", String(pid)], options);
  return name && name.status === 0 && name.stdout.trim() === path.basename(image).slice(0, 16)
    ? image
    : undefined;
}

/** A sealed Apple binary that opts out of argument inspection, such as mdworker. */
function isRedactedSystemImage(image: string): boolean {
  if (!image.startsWith("/System/")) {
    return false;
  }
  const result = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", image], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 && REDACTED_ARGUMENTS_ENTITLEMENT.test(result.stdout);
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
    return command &&
      [command.executable, command.argv[0] ?? ""].some(
        (value) => isNodeRuntime(value) || isBunRuntime(value) || path.basename(value) === "tsx",
      )
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
      // no-read-procargs, which then fails the alignment check. Those sealed
      // system binaries cannot hold OpenClaw artifacts. Other unparseable images
      // (non-UTF-8 argv) may, so they stay unknown.
      const image = readDarwinImagePath(pid);
      if (image && isRedactedSystemImage(image)) {
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
