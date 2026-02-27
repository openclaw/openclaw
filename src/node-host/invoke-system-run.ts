import crypto from "node:crypto";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  addAllowlistEntry,
  recordAllowlistUse,
  resolveAllowAlwaysPatterns,
  resolveExecApprovals,
  type ExecAllowlistEntry,
  type ExecAsk,
  type ExecCommandSegment,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import type { ExecHostRequest, ExecHostResponse, ExecHostRunResult } from "../infra/exec-host.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeSystemRunEnvOverrides } from "../infra/host-env-security.js";
import { resolveSystemRunCommand } from "../infra/system-run-command.js";
import { evaluateSystemRunPolicy, resolveExecApprovalDecision } from "./exec-policy.js";
import {
  applyOutputTruncation,
  evaluateSystemRunAllowlist,
  resolvePlannedAllowlistArgv,
  resolveSystemRunExecArgv,
} from "./invoke-system-run-allowlist.js";
import { hardenApprovedExecutionPaths } from "./invoke-system-run-plan.js";
import type {
  ExecEventPayload,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";

type SystemRunInvokeResult = {
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

type SystemRunDeniedReason =
  | "security=deny"
  | "approval-required"
  | "allowlist-miss"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "permission:screenRecording";

type SystemRunExecutionContext = {
  sessionKey: string;
  runId: string;
  cmdText: string;
};

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;

type SystemRunParsePhase = {
  argv: string[];
  shellCommand: string | null;
  cmdText: string;
  agentId: string | undefined;
  sessionKey: string;
  runId: string;
  execution: SystemRunExecutionContext;
  approvalDecision: ReturnType<typeof resolveExecApprovalDecision>;
  envOverrides: Record<string, string> | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
  needsScreenRecording: boolean;
  approved: boolean;
};

type SystemRunPolicyPhase = SystemRunParsePhase & {
  approvals: ResolvedExecApprovals;
  security: ExecSecurity;
  policy: ReturnType<typeof evaluateSystemRunPolicy>;
  allowlistMatches: ExecAllowlistEntry[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: ExecCommandSegment[];
  plannedAllowlistArgv: string[] | undefined;
  isWindows: boolean;
};

const safeBinTrustedDirWarningCache = new Set<string>();

function warnWritableTrustedDirOnce(message: string): void {
  if (safeBinTrustedDirWarningCache.has(message)) {
    return;
  }
  safeBinTrustedDirWarningCache.add(message);
  console.warn(message);
}

function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

export type HandleSystemRunInvokeOptions = {
  client: GatewayClient;
  params: SystemRunParams;
  skillBins: SkillBinsProvider;
  execHostEnforced: boolean;
  execHostFallbackAllowed: boolean;
  resolveExecSecurity: (value?: string) => ExecSecurity;
  resolveExecAsk: (value?: string) => ExecAsk;
  isCmdExeInvocation: (argv: string[]) => boolean;
  sanitizeEnv: (overrides?: Record<string, string> | null) => Record<string, string> | undefined;
  runCommand: (
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutMs: number | undefined,
  ) => Promise<RunResult>;
  runViaMacAppExecHost: (params: {
    approvals: ReturnType<typeof resolveExecApprovals>;
    request: ExecHostRequest;
  }) => Promise<ExecHostResponse | null>;
  sendNodeEvent: (client: GatewayClient, event: string, payload: unknown) => Promise<void>;
  buildExecEventPayload: (payload: ExecEventPayload) => ExecEventPayload;
  sendInvokeResult: (result: SystemRunInvokeResult) => Promise<void>;
  sendExecFinishedEvent: (params: {
    sessionKey: string;
    runId: string;
    cmdText: string;
    result: {
      stdout?: string;
      stderr?: string;
      error?: string | null;
      exitCode?: number | null;
      timedOut?: boolean;
      success?: boolean;
    };
  }) => Promise<void>;
  preferMacAppExecHost: boolean;
};

async function sendSystemRunDenied(
  opts: Pick<
    HandleSystemRunInvokeOptions,
    "client" | "sendNodeEvent" | "buildExecEventPayload" | "sendInvokeResult"
  >,
  execution: SystemRunExecutionContext,
  params: {
    reason: SystemRunDeniedReason;
    message: string;
  },
) {
  await opts.sendNodeEvent(
    opts.client,
    "exec.denied",
    opts.buildExecEventPayload({
      sessionKey: execution.sessionKey,
      runId: execution.runId,
      host: "node",
      command: execution.cmdText,
      reason: params.reason,
    }),
  );
  await opts.sendInvokeResult({
    ok: false,
    error: { code: "UNAVAILABLE", message: params.message },
  });
}

export { formatSystemRunAllowlistMissMessage } from "./exec-policy.js";
export { buildSystemRunApprovalPlanV2 } from "./invoke-system-run-plan.js";

async function parseSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
): Promise<SystemRunParsePhase | null> {
  const command = resolveSystemRunCommand({
    command: opts.params.command,
    rawCommand: opts.params.rawCommand,
  });
  if (!command.ok) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: command.message },
    });
    return null;
  }
  if (command.argv.length === 0) {
    await opts.sendInvokeResult({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "command required" },
    });
    return null;
  }

  const shellCommand = command.shellCommand;
  const cmdText = command.cmdText;
  const agentId = opts.params.agentId?.trim() || undefined;
  const sessionKey = opts.params.sessionKey?.trim() || "node";
  const runId = opts.params.runId?.trim() || crypto.randomUUID();
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: opts.params.env ?? undefined,
    shellWrapper: shellCommand !== null,
  });
  return {
    argv: command.argv,
    shellCommand,
    cmdText,
    agentId,
    sessionKey,
    runId,
    execution: { sessionKey, runId, cmdText },
    approvalDecision: resolveExecApprovalDecision(opts.params.approvalDecision),
    envOverrides,
    env: opts.sanitizeEnv(envOverrides),
    cwd: opts.params.cwd?.trim() || undefined,
    timeoutMs: opts.params.timeoutMs ?? undefined,
    needsScreenRecording: opts.params.needsScreenRecording === true,
    approved: opts.params.approved === true,
  };
}

async function evaluateSystemRunPolicyPhase(
  opts: HandleSystemRunInvokeOptions,
  parsed: SystemRunParsePhase,
): Promise<SystemRunPolicyPhase | null> {
  const cfg = loadConfig();
  const agentExec = parsed.agentId
    ? resolveAgentConfig(cfg, parsed.agentId)?.tools?.exec
    : undefined;
  const configuredSecurity = opts.resolveExecSecurity(
    agentExec?.security ?? cfg.tools?.exec?.security,
  );
  const configuredAsk = opts.resolveExecAsk(agentExec?.ask ?? cfg.tools?.exec?.ask);
  const approvals = resolveExecApprovals(parsed.agentId, {
    security: configuredSecurity,
    ask: configuredAsk,
  });
  const security = approvals.agent.security;
  const ask = approvals.agent.ask;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const { safeBins, safeBinProfiles, trustedSafeBinDirs } = resolveExecSafeBinRuntimePolicy({
    global: cfg.tools?.exec,
    local: agentExec,
    onWarning: warnWritableTrustedDirOnce,
  });
  const bins = autoAllowSkills ? await opts.skillBins.current() : [];
  let { analysisOk, allowlistMatches, allowlistSatisfied, segments } = evaluateSystemRunAllowlist({
    shellCommand: parsed.shellCommand,
    argv: parsed.argv,
    approvals,
    security,
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    cwd: parsed.cwd,
    env: parsed.env,
    skillBins: bins,
    autoAllowSkills,
  });
  const isWindows = process.platform === "win32";
  const cmdInvocation = parsed.shellCommand
    ? opts.isCmdExeInvocation(segments[0]?.argv ?? [])
    : opts.isCmdExeInvocation(parsed.argv);
  const policy = evaluateSystemRunPolicy({
    security,
    ask,
    analysisOk,
    allowlistSatisfied,
    approvalDecision: parsed.approvalDecision,
    approved: parsed.approved,
    isWindows,
    cmdInvocation,
    shellWrapperInvocation: parsed.shellCommand !== null,
  });
  analysisOk = policy.analysisOk;
  allowlistSatisfied = policy.allowlistSatisfied;
  if (!policy.allowed) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: policy.eventReason,
      message: policy.errorMessage,
    });
    return null;
  }

  // Fail closed if policy/runtime drift re-allows unapproved shell wrappers.
  if (security === "allowlist" && parsed.shellCommand && !policy.approvedByAsk) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: "SYSTEM_RUN_DENIED: approval required",
    });
    return null;
  }

  const hardenedPaths = hardenApprovedExecutionPaths({
    approvedByAsk: policy.approvedByAsk,
    argv: parsed.argv,
    shellCommand: parsed.shellCommand,
    cwd: parsed.cwd,
  });
  if (!hardenedPaths.ok) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "approval-required",
      message: hardenedPaths.message,
    });
    return null;
  }

  const plannedAllowlistArgv = resolvePlannedAllowlistArgv({
    security,
    shellCommand: parsed.shellCommand,
    policy,
    segments,
  });
  if (plannedAllowlistArgv === null) {
    await sendSystemRunDenied(opts, parsed.execution, {
      reason: "execution-plan-miss",
      message: "SYSTEM_RUN_DENIED: execution plan mismatch",
    });
    return null;
  }
  return {
    ...parsed,
    argv: hardenedPaths.argv,
    cwd: hardenedPaths.cwd,
    approvals,
    security,
    policy,
    allowlistMatches,
    analysisOk,
    allowlistSatisfied,
    segments,
    plannedAllowlistArgv: plannedAllowlistArgv ?? undefined,
    isWindows,
  };
}

async function executeSystemRunPhase(
  opts: HandleSystemRunInvokeOptions,
  phase: SystemRunPolicyPhase,
): Promise<void> {
  const useMacAppExec = opts.preferMacAppExecHost;
  if (useMacAppExec) {
    const execRequest: ExecHostRequest = {
      command: phase.plannedAllowlistArgv ?? phase.argv,
      // Forward canonical display text so companion approval/prompt surfaces bind to
      // the exact command context already validated on the node-host.
      rawCommand: phase.cmdText || null,
      cwd: phase.cwd ?? null,
      env: phase.envOverrides ?? null,
      timeoutMs: phase.timeoutMs ?? null,
      needsScreenRecording: phase.needsScreenRecording,
      agentId: phase.agentId ?? null,
      sessionKey: phase.sessionKey ?? null,
      approvalDecision: phase.approvalDecision,
    };
    const response = await opts.runViaMacAppExecHost({
      approvals: phase.approvals,
      request: execRequest,
    });
    if (!response) {
      if (opts.execHostEnforced || !opts.execHostFallbackAllowed) {
        await sendSystemRunDenied(opts, phase.execution, {
          reason: "companion-unavailable",
          message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
        });
        return;
      }
    } else if (!response.ok) {
      await sendSystemRunDenied(opts, phase.execution, {
        reason: normalizeDeniedReason(response.error.reason),
        message: response.error.message,
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      await opts.sendExecFinishedEvent({
        sessionKey: phase.sessionKey,
        runId: phase.runId,
        cmdText: phase.cmdText,
        result,
      });
      await opts.sendInvokeResult({
        ok: true,
        payloadJSON: JSON.stringify(result),
      });
      return;
    }
  }

  if (phase.policy.approvalDecision === "allow-always" && phase.security === "allowlist") {
    if (phase.policy.analysisOk) {
      const patterns = resolveAllowAlwaysPatterns({
        segments: phase.segments,
        cwd: phase.cwd,
        env: phase.env,
        platform: process.platform,
      });
      for (const pattern of patterns) {
        if (pattern) {
          addAllowlistEntry(phase.approvals.file, phase.agentId, pattern);
        }
      }
    }
  }

  if (phase.allowlistMatches.length > 0) {
    const seen = new Set<string>();
    for (const match of phase.allowlistMatches) {
      if (!match?.pattern || seen.has(match.pattern)) {
        continue;
      }
      seen.add(match.pattern);
      recordAllowlistUse(
        phase.approvals.file,
        phase.agentId,
        match,
        phase.cmdText,
        phase.segments[0]?.resolution?.resolvedPath,
      );
    }
  }

  if (phase.needsScreenRecording) {
    await sendSystemRunDenied(opts, phase.execution, {
      reason: "permission:screenRecording",
      message: "PERMISSION_MISSING: screenRecording",
    });
    return;
  }

  const execArgv = resolveSystemRunExecArgv({
    plannedAllowlistArgv: phase.plannedAllowlistArgv,
    argv: phase.argv,
    security: phase.security,
    isWindows: phase.isWindows,
    policy: phase.policy,
    shellCommand: phase.shellCommand,
    segments: phase.segments,
  });

  const result = await opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs);
  applyOutputTruncation(result);
  await opts.sendExecFinishedEvent({
    sessionKey: phase.sessionKey,
    runId: phase.runId,
    cmdText: phase.cmdText,
    result,
  });

  await opts.sendInvokeResult({
    ok: true,
    payloadJSON: JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
    }),
  });
}

export async function handleSystemRunInvoke(opts: HandleSystemRunInvokeOptions): Promise<void> {
  const parsed = await parseSystemRunPhase(opts);
  if (!parsed) {
    return;
  }
  const policyPhase = await evaluateSystemRunPolicyPhase(opts, parsed);
  if (!policyPhase) {
    return;
  }
  await executeSystemRunPhase(opts, policyPhase);
}
