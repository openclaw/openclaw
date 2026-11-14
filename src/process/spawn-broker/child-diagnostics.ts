import type { ChildProcess } from "node:child_process";
import { prepareChildRuntimeFailure } from "../../infra/child-runtime-viability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf8Suffix } from "../../utils/utf8-truncate.js";
import { SpawnBrokerError } from "./protocol.js";

/** Capture the final stderr tail before the owner reports the child's exit. */
export function observeBrokerChildDiagnostics(child: ChildProcess): () => Promise<Error> {
  const execPath = process.execPath;
  let started = false;
  child.once("message", () => {
    started = true;
  });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrTail = truncateUtf8Suffix(stderrTail + chunk, 2048);
  });
  return async () => {
    const stderr = redactToolPayloadText(stderrTail).trim();
    return (
      (await prepareChildRuntimeFailure({
        execPath,
        stderr: stderrTail,
        signal: child.signalCode,
        started,
      })) ??
      new Error(
        `exited with code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"}${stderr ? `\nstderr:\n${stderr}` : ""}`,
      )
    );
  };
}

export async function prepareBrokerFailureCause(
  diagnosis: Promise<Error | undefined>,
  nativeCause?: Error,
): Promise<Error | undefined> {
  try {
    return (await diagnosis) ?? nativeCause;
  } catch (error) {
    return new AggregateError(
      nativeCause ? [nativeCause, error] : [error],
      "Spawn broker diagnosis failed",
      { cause: nativeCause },
    );
  }
}

export function createBrokerFailureError(cause: Error | undefined, hasBeenReady: boolean) {
  return new SpawnBrokerError(
    cause && hasErrnoCode(cause, "NODE_RUNTIME_UNAVAILABLE")
      ? cause.message
      : hasBeenReady
        ? "Spawn broker exited; command outcome is unavailable"
        : `Spawn broker failed before readiness: ${cause?.message ?? "channel lost"}`,
    { cause },
  );
}
