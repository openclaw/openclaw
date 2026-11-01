import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createCommandError } from "../process/command-error.js";
import type { BufferedCommandResult } from "../process/exec.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export function createGitHubPublicationGitError(
  failure: string,
  stage: string,
  result: BufferedCommandResult,
  timeoutMs: number,
): Error {
  const reason = createCommandError(
    `Git ${stage}`,
    { ...result, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: undefined },
    { timeoutMs },
  ).message;
  // These diagnostics reach receipt readers and recovery warnings. Sanitize
  // complete details before truncation can remove a URL or credential prefix.
  const diagnostic = [
    reason,
    result.error ? formatErrorMessage(result.error, { includeCode: true }) : "",
    result.stderr.toString("utf8"),
  ]
    .filter(Boolean)
    .join(": ");
  const detail = truncateUtf8Prefix(
    redactToolPayloadText(
      sanitizeForLog(diagnostic.replace(/[\r\n\t]+/gu, " ")).replace(
        /\b[a-z][a-z\d+.-]*:\/\/\S+/giu,
        "[redacted URL]",
      ),
    ).trim(),
    1_024,
  );
  return new Error(`${failure} ${detail}`);
}
