import { asOptionalRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import type { ServiceChildStart } from "./service-child-protocol.js";

export function isWindowsJobServiceStart(value: unknown): value is ServiceChildStart {
  const message = asOptionalRecord(value);
  return Boolean(
    message &&
    (message.type === "start" || message.type === "prepare") &&
    typeof message.generation === "string" &&
    typeof message.command === "string" &&
    Array.isArray(message.args) &&
    message.args.every((arg) => typeof arg === "string") &&
    (message.argv0 === undefined || typeof message.argv0 === "string") &&
    (message.cwd === undefined || typeof message.cwd === "string") &&
    (message.env === undefined || isStringRecord(message.env)) &&
    (message.stdinMode === "inherit" ||
      message.stdinMode === "pipe-open" ||
      message.stdinMode === "pipe-closed") &&
    (message.secretFd === undefined || typeof message.secretFd === "number") &&
    (message.controlFd === undefined || typeof message.controlFd === "number") &&
    (message.windowsShellCommand === undefined || typeof message.windowsShellCommand === "string"),
  );
}
