import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";

export function backgroundCommandTaskSummary(status: DetachedTaskTerminalState["status"]) {
  return {
    succeeded: "Command completed",
    failed: "Command failed",
    cancelled: "Command stopped",
    timed_out: "Command timed out",
  }[status];
}

/** Redact before truncation so a shortened secret cannot escape masking. */
export function backgroundCommandTaskContent(input: string) {
  const command = stripAnsi(redactToolPayloadText(input))
    .replace(/\p{Cc}/gu, (control) => ("\r\n\t".includes(control) ? control : ""))
    .trim();
  const label =
    truncateWithMarker(command.replace(/\s+/gu, " "), 120, {
      marker: "…",
      reserve: 1,
      trimEnd: true,
    }) || "CLI command";
  return { label, task: command || label };
}
