import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { isBlockedShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { materializeInlineEvalForApprovalSync } from "./invoke-system-run-inline-eval.js";
import {
  hardenApprovedExecutionPaths,
  resolveMutableFileOperandSnapshotSync,
} from "./invoke-system-run-plan.js";

export function buildSystemRunApprovalPlan(params: {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): { ok: true; plan: SystemRunApprovalPlan } | { ok: false; message: string } {
  const command = resolveSystemRunCommandRequest({
    command: params.command,
    rawCommand: params.rawCommand,
  });
  if (!command.ok) {
    return { ok: false, message: command.message };
  }
  if (command.argv.length === 0) {
    return { ok: false, message: "command required" };
  }
  if (command.shellPayload === null && isBlockedShellWrapperCommand(command.argv)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  const cwd = normalizeNullableString(params.cwd) ?? undefined;
  const materializedInlineEval = materializeInlineEvalForApprovalSync(command.argv, cwd);
  if (!materializedInlineEval.ok) {
    return { ok: false, message: materializedInlineEval.message };
  }
  const approvalArgv = materializedInlineEval.command?.argv ?? command.argv;
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: true,
    argv: approvalArgv,
    shellCommand: command.shellPayload,
    cwd,
  });
  if (!hardening.ok) {
    return { ok: false, message: hardening.message };
  }
  const commandText = formatExecCommand(hardening.argv);
  const commandPreview =
    materializedInlineEval.command !== null
      ? command.commandText
      : command.previewText?.trim() && command.previewText.trim() !== commandText
        ? command.previewText.trim()
        : null;
  const mutableFileOperand = resolveMutableFileOperandSnapshotSync({
    argv: hardening.argv,
    cwd: hardening.cwd,
    shellCommand: command.shellPayload,
  });
  if (!mutableFileOperand.ok) {
    return { ok: false, message: mutableFileOperand.message };
  }
  return {
    ok: true,
    plan: {
      argv: hardening.argv,
      cwd: hardening.cwd ?? null,
      commandText,
      commandPreview,
      agentId: normalizeNullableString(params.agentId),
      sessionKey: normalizeNullableString(params.sessionKey),
      mutableFileOperand: mutableFileOperand.snapshot ?? undefined,
    },
  };
}
