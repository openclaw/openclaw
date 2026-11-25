import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecPolicyScopeSnapshot } from "../infra/exec-approvals-effective.js";
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

/** Cells own their line breaks; each line is sanitized as its own value so a value cannot add one. */
export function renderEffectivePolicyTable(scopes: readonly ExecPolicyScopeSnapshot[]): string {
  const cell = (...lines: string[]) => lines.map(sanitizeTerminalText).join("\n");
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Scope", header: "Scope", minWidth: 12 },
      { key: "Requested", header: "Requested", minWidth: 24, flex: true },
      { key: "Host", header: "Host", minWidth: 24, flex: true },
      { key: "Effective", header: "Effective", minWidth: 16 },
      { key: "Notes", header: "Notes", minWidth: 20, flex: true },
    ],
    rows: scopes.map((summary) => ({
      Scope: cell(summary.scopeLabel),
      Requested: cell(
        `security=${summary.security.requested} (${summary.security.requestedSource})`,
        `ask=${summary.ask.requested} (${summary.ask.requestedSource})`,
      ),
      Host: cell(
        `security=${summary.security.host} (${summary.security.hostSource})`,
        `ask=${summary.ask.host} (${summary.ask.hostSource})`,
        `askFallback=${summary.askFallback.effective} (${summary.askFallback.source})`,
      ),
      Effective: cell(`security=${summary.security.effective}`, `ask=${summary.ask.effective}`),
      Notes: cell(`${summary.security.note}; ${summary.ask.note}`),
    })),
  }).trimEnd();
}
