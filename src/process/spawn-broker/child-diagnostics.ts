import type { ChildProcess } from "node:child_process";
import { redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

/** Capture the final stderr tail before the owner reports the child's exit. */
export function observeBrokerChildDiagnostics(child: ChildProcess): () => Error {
  let stderrTail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderrTail = truncateUtf8Suffix(stderrTail + chunk, 2048);
  });
  return () => {
    const stderr = redactToolPayloadText(stderrTail).trim();
    return new Error(
      `exited with code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"}${stderr ? `\nstderr:\n${stderr}` : ""}`,
    );
  };
}
