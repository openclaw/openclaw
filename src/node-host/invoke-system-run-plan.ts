/** Builds and revalidates system.run approval plans for cwd and executable paths. */
import fs from "node:fs";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  analyzeArgvCommand,
  resolveAllowAlwaysPatternCoverage,
  type SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import {
  extractShellWrapperCommand,
  isBlockedShellWrapperCommand,
  isShellWrapperInvocation,
} from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeHostExecEnv,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import {
  resolveMutableFileOperandSnapshotSync,
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../infra/system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import {
  type ApprovedCwdSnapshot,
  captureApprovedCwdSnapshotSync,
  revalidateApprovedCwdSnapshot,
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
} from "../infra/system-run-cwd-binding.js";
import { revalidateApprovedMutableFileOperand } from "../infra/system-run-file-snapshot.js";
import type { SystemRunBindingFailure } from "../infra/system-run-mutable-file-operand.js";
import { logWarn } from "../logger.js";

/** Revalidate the approved path facts after the execution-policy commit yields. */
export async function revalidateSystemRunApprovedPathBindings(phase: {
  approvedCwdSnapshot?: ApprovedCwdSnapshot;
  approvalPlan: SystemRunApprovalPlan | null;
  argv: string[];
  cwd: string | undefined;
  executableBinding?: SystemRunMutableFileBinding;
  runId: string;
}): Promise<string | undefined> {
  if (phase.approvedCwdSnapshot && !revalidateApprovedCwdSnapshot(phase.approvedCwdSnapshot)) {
    logWarn("security: system.run approval cwd drift blocked (runId=" + phase.runId + ")");
    return APPROVAL_CWD_DRIFT_DENIED_MESSAGE;
  }
  if (
    phase.approvalPlan?.mutableFileOperand &&
    !revalidateApprovedMutableFileOperand({
      snapshot: phase.approvalPlan.mutableFileOperand,
      argv: phase.argv,
      cwd: phase.cwd,
    })
  ) {
    logWarn("security: system.run approval script drift blocked (runId=" + phase.runId + ")");
    return APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE;
  }
  if (phase.executableBinding) {
    const revalidated = await revalidateSystemRunMutableFileBinding({
      binding: phase.executableBinding,
      cwd: phase.cwd,
    });
    if (!revalidated.ok) {
      logWarn("security: system.run approval executable drift blocked (runId=" + phase.runId + ")");
      return revalidated.message;
    }
  }
  return undefined;
}

type SystemRunPrepareEnv =
  | {
      ok: true;
      env: Record<string, string>;
    }
  | {
      ok: false;
      message: string;
    };
export function buildEnvOverrideRejectionMessage(params: {
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
}): string {
  const details: string[] = [];
  if (params.rejectedOverrideBlockedKeys.length > 0) {
    details.push(`blocked override keys: ${params.rejectedOverrideBlockedKeys.join(", ")}`);
  }
  if (params.rejectedOverrideInvalidKeys.length > 0) {
    details.push(
      `invalid non-portable override keys: ${params.rejectedOverrideInvalidKeys.join(", ")}`,
    );
  }
  return `SYSTEM_RUN_DENIED: environment override rejected (${details.join("; ")})`;
}

export function buildSystemRunPrepareCoverageEnv(params: {
  argv: string[];
  env?: Record<string, string> | null;
}): SystemRunPrepareEnv {
  const diagnostics = inspectHostExecEnvOverrides({
    overrides: params.env ?? undefined,
    blockPathOverrides: true,
  });
  if (
    diagnostics.rejectedOverrideBlockedKeys.length > 0 ||
    diagnostics.rejectedOverrideInvalidKeys.length > 0
  ) {
    return {
      ok: false,
      message: buildEnvOverrideRejectionMessage(diagnostics),
    };
  }
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: params.env ?? undefined,
    shellWrapper: isShellWrapperInvocation(params.argv),
  });
  return {
    ok: true,
    // Prepared coverage is durable approval evidence, so keep this in parity
    // with the env passed to `system.run` policy and execution.
    env: sanitizeHostExecEnv({ overrides: envOverrides, blockPathOverrides: true }),
  };
}

export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}):
  | {
      ok: true;
      argv: string[];
      argvChanged: boolean;
      cwd: string | undefined;
      approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
    }
  | { ok: false; message: string } {
  if (!params.approvedByAsk) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: params.cwd,
      approvedCwdSnapshot: undefined,
    };
  }

  // Capture an omitted cwd once on the execution host. Approval, persistence,
  // revalidation, and process launch must all bind the same directory identity.
  const canonicalCwd = captureApprovedCwdSnapshotSync(params.cwd ?? process.cwd());
  if (!canonicalCwd.ok) {
    return canonicalCwd;
  }
  const hardened = {
    ok: true as const,
    argv: params.argv,
    argvChanged: false,
    cwd: canonicalCwd.snapshot.cwd,
    approvedCwdSnapshot: canonicalCwd.snapshot,
  };

  const resolution = resolveCommandResolutionFromArgv(params.argv, hardened.cwd);
  if (
    params.argv.length === 0 ||
    params.shellCommand !== null ||
    (resolution?.wrapperChain?.length ?? 0) !== 0
  ) {
    // Wrapper argv must stay intact: replacing its effective executable can shift
    // positional arguments and run a different command than the approved one.
    return hardened;
  }

  const pinnedExecutable =
    resolution?.execution.resolvedRealPath ?? resolution?.execution.resolvedPath;
  if (!pinnedExecutable) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    };
  }
  if (pinnedExecutable === params.argv[0]) {
    return hardened;
  }
  const argv = [...params.argv];
  argv[0] = pinnedExecutable;
  return { ...hardened, argv, argvChanged: true };
}

export function buildSystemRunApprovalPlan(
  params: {
    command?: unknown;
    rawCommand?: unknown;
    cwd?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
  },
  bindApproval = true,
): { ok: true; plan: SystemRunApprovalPlan } | SystemRunBindingFailure {
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
  if (bindApproval && command.shellPayload === null && isBlockedShellWrapperCommand(command.argv)) {
    return {
      ok: false,
      reason: "unsupported-command-shape",
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  let cwd = normalizeNullableString(params.cwd) ?? undefined;
  if (!bindApproval) {
    // Ordinary execution follows aliases once; approval binding keeps its stricter path checks.
    try {
      cwd = fs.realpathSync(cwd ?? process.cwd());
    } catch {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: working directory does not exist or is inaccessible",
      };
    }
  }
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: bindApproval,
    argv: command.argv,
    shellCommand: command.shellPayload,
    cwd,
  });
  if (!hardening.ok) {
    return hardening;
  }
  const commandText = formatExecCommand(hardening.argv);
  const commandPreview =
    command.previewText?.trim() && command.previewText.trim() !== commandText
      ? command.previewText.trim()
      : null;
  const mutableFileOperand = bindApproval
    ? resolveMutableFileOperandSnapshotSync({
        argv: hardening.argv,
        cwd: hardening.cwd,
        shellCommand: command.shellPayload,
      })
    : { ok: true as const, snapshot: null };
  if (!mutableFileOperand.ok) {
    return mutableFileOperand;
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

export async function buildSystemRunAllowAlwaysCoverage(params: {
  argv: string[];
  rawCommand?: string | null;
  cwd: string | null | undefined;
  env: Record<string, string> | undefined;
  strictInlineEval?: boolean;
}) {
  const cwd = params.cwd ?? undefined;
  const shellWrapper = extractShellWrapperCommand(params.argv, params.rawCommand);
  if (shellWrapper.isWrapper) {
    if (!shellWrapper.command) {
      return { complete: false, patterns: [] };
    }
    const authorizationPlan = await planShellAuthorization({
      command: shellWrapper.command,
      cwd,
      env: params.env,
      platform: process.platform,
    });
    if (!authorizationPlan.ok) {
      return { complete: false, patterns: [] };
    }
    const candidates = authorizationPlan.groups.flatMap((group) => group.candidates);
    const reusableSegments = candidates
      .filter((candidate) => candidate.allowAlways)
      .map((candidate) => candidate.sourceSegment);
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: reusableSegments,
      cwd,
      env: params.env,
      platform: process.platform,
      strictInlineEval: params.strictInlineEval,
    });
    return {
      ...coverage,
      complete: coverage.complete && reusableSegments.length === candidates.length,
    };
  }
  const analysis = analyzeArgvCommand({ argv: params.argv, cwd, env: params.env });
  if (!analysis.ok) {
    return { complete: false, patterns: [] };
  }
  return resolveAllowAlwaysPatternCoverage({
    segments: analysis.segments,
    cwd,
    env: params.env,
    platform: process.platform,
    strictInlineEval: params.strictInlineEval,
  });
}
