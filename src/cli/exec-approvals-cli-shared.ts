// Helpers shared by the approvals CLI entrypoints (exec-approvals-cli.ts and
// exec-approvals-history.ts). Kept in a sibling module so the ledger views can
// reuse one terminal-safety and failure contract without importing the whole
// command surface.
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  ApprovalDecision,
  ApprovalResolveResult,
  ApprovalSnapshot,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { rethrowExpectedCliError } from "./failure-output.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

export type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
  reason?: string;
  expiresInDays?: string;
};

export const APPROVAL_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

const APPROVAL_TERMINAL_UNSAFE_CHAR =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;

export function exitWithError(message: string): never {
  throw new Error(message);
}

export function formatCliError(err: unknown): string {
  const msg = formatErrorMessage(err);
  const firstLine = msg.includes("\n") ? msg.split("\n")[0] : msg;
  const safe = sanitizeForLog(expectDefined(firstLine, "exec approvals cli first line"));
  return safe.length > 300 ? `${truncateUtf16Safe(safe, 300)}...` : safe;
}

export function failApprovalsCommand(err: unknown, opts: ExecApprovalsCliOpts): void {
  rethrowExpectedCliError(err);
  const message = formatCliError(err);
  if (opts.json) {
    throw new Error(message);
  }
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
}

export function isApprovalDecision(value: string): value is ApprovalDecision {
  const decisions: readonly string[] = APPROVAL_DECISIONS;
  return decisions.includes(value);
}

export function escapeApprovalTextForTerminal(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (char === "\\") {
      escaped += "\\\\";
      continue;
    }
    if (APPROVAL_TERMINAL_UNSAFE_CHAR.test(char)) {
      escaped += `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
      continue;
    }
    escaped += char;
  }
  return escaped;
}

export function approvalRecordedDecision(approval: ApprovalSnapshot): ApprovalDecision | null {
  return "decision" in approval && isApprovalDecision(approval.decision) ? approval.decision : null;
}

export function formatResolver(approval: ApprovalResolveResult["approval"]): string {
  const resolver = approval.resolver;
  if (!resolver) {
    return "unknown resolver";
  }
  return resolver.id
    ? `${resolver.kind}:${escapeApprovalTextForTerminal(resolver.id)}`
    : resolver.kind;
}
