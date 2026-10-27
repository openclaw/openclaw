import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../infra/errors.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { defaultRuntime } from "../runtime.js";
import { rethrowExpectedCliError } from "./failure-output.js";

export const EXEC_APPROVALS_STDIN_MAX_BYTES = 1024 * 1024;

export async function readStdin(): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: EXEC_APPROVALS_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes: limit }) => new Error(`Exec approvals stdin exceeds ${limit} bytes.`),
  });
  return decodeUtf8Input(bytes, "Exec approvals stdin");
}

export function formatCliError(err: unknown): string {
  const msg = formatErrorMessage(err);
  const firstLine = msg.includes("\n") ? msg.split("\n")[0] : msg;
  const safe = sanitizeForLog(expectDefined(firstLine, "exec approvals cli first line"));
  return safe.length > 300 ? `${truncateUtf16Safe(safe, 300)}...` : safe;
}

function failApprovalsCommand(err: unknown, opts: { json?: boolean }): void {
  rethrowExpectedCliError(err);
  const message = formatCliError(err);
  if (opts.json) {
    // Expose the bounded diagnostic without attaching its unsanitized cause.
    throw new Error(message);
  }
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
}

export async function runApprovalsAction(
  opts: { json?: boolean },
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    failApprovalsCommand(err, opts);
  }
}
