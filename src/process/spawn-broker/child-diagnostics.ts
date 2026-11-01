import type { ChildProcess } from "node:child_process";
import { classifyChildRuntimeFailure } from "../../infra/child-runtime-viability.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

/** Capture the final stderr tail before the owner reports the child's exit. */
export function observeBrokerChildDiagnostics(child: ChildProcess): () => Error {
  const execPath = process.execPath;
  let started = false;
  child.once("message", () => {
    started = true;
  });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrTail = truncateUtf8Suffix(stderrTail + chunk, 2048);
  });
  return () => {
    const stderr = redactToolPayloadText(stderrTail).trim();
    return (
      classifyChildRuntimeFailure({
        execPath,
        stderr: stderrTail,
        signal: child.signalCode,
        started,
      }) ??
      new Error(
        `exited with code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"}${stderr ? `\nstderr:\n${stderr}` : ""}`,
      )
    );
  };
}
