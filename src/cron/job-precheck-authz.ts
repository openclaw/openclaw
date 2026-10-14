import { describeInterpreterInlineEval } from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import {
  evaluateShellAllowlistWithAuthorization,
  resolveExecApprovalsLocked,
  resolveExecModePolicy,
  minSecurity,
  requiresExecApproval,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import type { SafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { evaluateSystemRunPolicy } from "../node-host/exec-policy.js";
import {
  PRECHECK_POLICY_DENIED_REASON,
  PRECHECK_TRIGGERS_DISABLED,
  cronToolsAllowPermitsPrecheckExec,
  resolvePrecheckExecEnv,
} from "./job-precheck-shared.js";

type ExecHost = "auto" | "sandbox" | "gateway" | "node";

type ExecToolConfigLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  /** Require approval for interpreter inline-eval carriers (python -c, etc.). */
  strictInlineEval?: boolean;
  /** tools.exec.host — precheck only spawns gateway-local shells. */
  host?: ExecHost;
  /** tools.exec.node target (informational for deny reasons). */
  node?: string;
  /** Global/agent tools.exec.safeBins — same surface as system.run. */
  safeBins?: string[] | null;
  safeBinProfiles?: SafeBinProfileFixtures | null;
  safeBinTrustedDirs?: string[] | null;
};

export type CronJobPrecheckAuthz = {
  /** Operator must enable unattended cron scripts/triggers (same gate as script payloads). */
  triggersEnabled: boolean;
  /** Optional agent id for exec-approvals agent scope. */
  agentId?: string;
  /**
   * Caller's requested exec security contract (tools.exec.security). Host approvals
   * file may only tighten further via minSecurity inside resolve. Defaults to the
   * resolved approvals agent security when omitted.
   */
  security?: ExecSecurity;
  /**
   * Global `tools.exec` config layer (same as system.run). Applied before agent layer.
   * When set, layered policy becomes the requested security ceiling (not approvals alone).
   */
  toolsExec?: ExecToolConfigLayer;
  /**
   * Per-agent `agents.entries.<id>.tools.exec` config layer (same as system.run).
   */
  agentToolsExec?: ExecToolConfigLayer;
  /**
   * Explicit strictInlineEval override (tests). When omitted, OR of global/agent
   * tools.exec.strictInlineEval layers (same as system.run).
   */
  strictInlineEval?: boolean;
  /**
   * When true, skip live approvals resolution and use `security` (or deny) only.
   * Tests inject this to assert policy denial without host file side effects.
   */
  securityOverrideOnly?: boolean;
  /**
   * Job payload toolsAllow (caller-scoped cron tool cap). When set and it does not
   * permit exec/shell, precheck is denied even if global/agent tools.exec allows it.
   * Undefined = unrestricted (legacy jobs without an explicit cap).
   */
  toolsAllow?: readonly string[] | null;
};

/** Normalize security strings; invalid values fail closed to deny. */
function normalizeExecSecurity(value: unknown): ExecSecurity | undefined {
  if (value === "deny" || value === "allowlist" || value === "full") {
    return value;
  }
  return undefined;
}

/**
 * Authorize a cron precheck command under the same host-shell policy surface as
 * the gateway exec tool: `cron.triggers.enabled` plus exec security
 * deny|allowlist|full (allowlist analysis via evaluateShellAllowlist*).
 * Unattended cron never prompts for approvals — effective ask that would
 * require a prompt fails closed (policy-denied).
 */
export async function authorizeCronJobPrecheckCommand(params: {
  command: string;
  cwd?: string;
  authz: CronJobPrecheckAuthz;
  env?: NodeJS.ProcessEnv;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!params.authz.triggersEnabled) {
    return { allowed: false, reason: PRECHECK_TRIGGERS_DISABLED };
  }

  if (!cronToolsAllowPermitsPrecheckExec(params.authz.toolsAllow)) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: job toolsAllow does not permit exec (host-shell precheck requires exec in the job tool cap)`,
    };
  }

  // Precheck only spawns Gateway-local shells. Honor tools.exec.host (agent > global):
  // sandbox/node/auto must fail closed — never bypass routing onto the gateway host
  // (ClawSweeper P1 on #112375).
  const resolveHost = (layer: ExecToolConfigLayer | undefined): ExecHost | undefined => {
    const h = layer?.host;
    return h === "auto" || h === "sandbox" || h === "gateway" || h === "node" ? h : undefined;
  };
  const resolveNode = (layer: ExecToolConfigLayer | undefined): string | undefined => {
    const n = layer?.node;
    return typeof n === "string" && n.trim().length > 0 ? n.trim() : undefined;
  };
  const effectiveHost =
    resolveHost(params.authz.agentToolsExec) ?? resolveHost(params.authz.toolsExec);
  if (effectiveHost !== undefined && effectiveHost !== "gateway") {
    const node = resolveNode(params.authz.agentToolsExec) ?? resolveNode(params.authz.toolsExec);
    const nodeHint = node ? ` node=${node}` : "";
    return {
      allowed: false,
      reason:
        `${PRECHECK_POLICY_DENIED_REASON}: exec host=${effectiveHost}${nodeHint} ` +
        `is not supported for cron precheck (gateway-local spawn only; refuse sandbox/node bypass)`,
    };
  }

  const requested = normalizeExecSecurity(params.authz.security);

  if (params.authz.securityOverrideOnly) {
    const security = requested ?? "deny";
    if (security === "deny") {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
      };
    }
    if (security === "full") {
      const strictInlineEval =
        params.authz.strictInlineEval === true ||
        params.authz.toolsExec?.strictInlineEval === true ||
        params.authz.agentToolsExec?.strictInlineEval === true;
      if (strictInlineEval) {
        const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
          global: params.authz.toolsExec,
          local: params.authz.agentToolsExec,
        });
        const allowlistEval = await evaluateShellAllowlistWithAuthorization({
          command: params.command,
          allowlist: [],
          safeBins: safeBinPolicy.safeBins,
          safeBinProfiles: safeBinPolicy.safeBinProfiles,
          trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
          cwd: params.cwd,
          env: resolvePrecheckExecEnv(params.env),
          platform: process.platform,
        });
        const inlineEvalHit = detectPolicyInlineEval(allowlistEval.segments ?? []);
        if (inlineEvalHit !== null) {
          return {
            allowed: false,
            reason:
              `${PRECHECK_POLICY_DENIED_REASON}: ` +
              `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode ` +
              `(unattended cron cannot prompt)`,
          };
        }
      }
      return { allowed: true };
    }
    // allowlist without live file → evaluate command against empty allowlist
    const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
      global: params.authz.toolsExec,
      local: params.authz.agentToolsExec,
    });
    const allowlistEval = await evaluateShellAllowlistWithAuthorization({
      command: params.command,
      allowlist: [],
      safeBins: safeBinPolicy.safeBins,
      safeBinProfiles: safeBinPolicy.safeBinProfiles,
      trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
      cwd: params.cwd,
      env: resolvePrecheckExecEnv(params.env),
      platform: process.platform,
    });
    const isWindows = process.platform === "win32";
    // Pass actual Windows cmd transport facts into the shared evaluator. Current
    // system.run policy requires approval for cmd.exe /c wrappers under allowlist
    // (builtins/quoting). Unattended cron cannot prompt, so this fails closed —
    // same as other host-shell gates. Do not lie about wrapper involvement.
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied: allowlistEval.allowlistSatisfied,
      approvalDecision: null,
      isWindows,
      cmdInvocation: isWindows,
      shellWrapperInvocation: isWindows,
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
      };
    }
    return { allowed: true };
  }

  // Mirror resolveEffectiveSystemRunExecPolicy / resolveExecHostApprovalContext:
  // 1) start from OpenClaw defaults (allowlist/off) or an explicit security ceiling
  // 2) layer global + per-agent tools.exec (canonical system.run path) — including ask
  // 3) resolveExecModePolicy with effective ask (not forced off)
  // 4) approvals file may only tighten via minSecurity / ask max-strictness
  // Unattended cron cannot prompt: if effective ask would require approval, deny.
  const normalizeAsk = (value: unknown): ExecAsk | undefined => {
    if (value === "off" || value === "on-miss" || value === "always") {
      return value;
    }
    return undefined;
  };
  const normalizeLayer = (
    layer: ExecToolConfigLayer | undefined,
  ): ExecToolConfigLayer | undefined => {
    if (!layer) {
      return undefined;
    }
    const host =
      layer.host === "auto" ||
      layer.host === "sandbox" ||
      layer.host === "gateway" ||
      layer.host === "node"
        ? layer.host
        : undefined;
    const node =
      typeof layer.node === "string" && layer.node.trim().length > 0
        ? layer.node.trim()
        : undefined;
    return {
      mode:
        layer.mode === "deny" ||
        layer.mode === "allowlist" ||
        layer.mode === "ask" ||
        layer.mode === "auto" ||
        layer.mode === "full"
          ? layer.mode
          : undefined,
      security: normalizeExecSecurity(layer.security),
      ask: normalizeAsk(layer.ask),
      // SAFETY: literal true narrowed to const boolean flag for ExecToolConfigLayer.
      ...(layer.strictInlineEval === true ? { strictInlineEval: true as const } : {}),
      ...(host ? { host } : {}),
      ...(node ? { node } : {}),
    };
  };
  const toolsExecLayer = normalizeLayer(params.authz.toolsExec);
  const agentToolsExecLayer = normalizeLayer(params.authz.agentToolsExec);
  const hasConfigLayers = toolsExecLayer !== undefined || agentToolsExecLayer !== undefined;
  // Canonical system.run default is allowlist when exec security is unspecified
  // (node-host/invoke.ts). Do not widen unconfigured prechecks to full.
  const defaultSecurity: ExecSecurity = requested ?? "allowlist";
  const unattendedAsk: ExecAsk = "off";
  const basePolicy = {
    security: defaultSecurity,
    ask: unattendedAsk,
  };
  const layered = hasConfigLayers
    ? applyExecPolicyLayer(applyExecPolicyLayer(basePolicy, toolsExecLayer), agentToolsExecLayer)
    : basePolicy;
  // Explicit authz.security remains a hard ceiling when config layers are also present.
  const ceilingSecurity =
    requested !== undefined
      ? minSecurity(normalizeExecSecurity(layered.security) ?? "allowlist", requested)
      : (normalizeExecSecurity(layered.security) ?? "allowlist");
  const layeredMode: ExecMode | undefined =
    "mode" in layered &&
    (layered.mode === "deny" ||
      layered.mode === "allowlist" ||
      layered.mode === "ask" ||
      layered.mode === "auto" ||
      layered.mode === "full")
      ? layered.mode
      : undefined;
  const layeredAsk = normalizeAsk(layered.ask) ?? "off";
  const modePolicy = resolveExecModePolicy({
    mode: layeredMode,
    security: ceilingSecurity ?? "allowlist",
    ask: layeredAsk,
  });
  const approvals = await resolveExecApprovalsLocked(params.authz.agentId, {
    security: modePolicy.security,
    ask: modePolicy.ask,
  });
  const hostSecurity = minSecurity(
    modePolicy.security,
    normalizeExecSecurity(approvals.agent.security) ?? "deny",
  );
  // Ask max-strictness: always > on-miss > off (approvals file can only tighten).
  const askRank = (ask: ExecAsk): number => (ask === "always" ? 2 : ask === "on-miss" ? 1 : 0);
  const approvalsAsk = normalizeAsk(approvals.agent.ask) ?? "off";
  const effectiveAsk: ExecAsk =
    askRank(approvalsAsk) >= askRank(modePolicy.ask) ? approvalsAsk : modePolicy.ask;

  if (hostSecurity === "deny") {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
    };
  }

  const safeBinPolicy = resolveExecSafeBinRuntimePolicy({
    global: params.authz.toolsExec,
    local: params.authz.agentToolsExec,
  });
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: safeBinPolicy.safeBins,
    safeBinProfiles: safeBinPolicy.safeBinProfiles,
    trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
    cwd: params.cwd,
    env: resolvePrecheckExecEnv(params.env),
    platform: process.platform,
  });

  const isWindows = process.platform === "win32";
  const allowlistSatisfied = hostSecurity === "allowlist" ? allowlistEval.allowlistSatisfied : true;
  // Honor tools.exec.strictInlineEval (system.run parity): unattended precheck cannot
  // prompt, so inline-eval carriers fail closed when the policy is enabled.
  const strictInlineEval =
    params.authz.strictInlineEval === true ||
    params.authz.toolsExec?.strictInlineEval === true ||
    params.authz.agentToolsExec?.strictInlineEval === true;
  if (strictInlineEval) {
    const inlineEvalHit = detectPolicyInlineEval(allowlistEval.segments ?? []);
    if (inlineEvalHit !== null) {
      return {
        allowed: false,
        reason:
          `${PRECHECK_POLICY_DENIED_REASON}: ` +
          `${describeInterpreterInlineEval(inlineEvalHit)} requires explicit approval in strictInlineEval mode ` +
          `(unattended cron cannot prompt)`,
      };
    }
  }
  // Unattended cron has no interactive approval path. Fail closed when the
  // effective ask policy would require a prompt (tools.exec.ask or approvals).
  if (
    requiresExecApproval({
      ask: effectiveAsk,
      security: hostSecurity,
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied: false,
    })
  ) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec ask=${effectiveAsk} requires approval (unattended cron cannot prompt)`,
    };
  }

  const decision = evaluateSystemRunPolicy({
    security: hostSecurity,
    ask: effectiveAsk,
    analysisOk: allowlistEval.analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied: false,
    approvalDecision: null,
    isWindows,
    // Report real Windows cmd.exe /d /s /c transport to preserve allowlist guard.
    cmdInvocation: isWindows,
    shellWrapperInvocation: isWindows,
  });

  if (!decision.allowed) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
    };
  }
  return { allowed: true };
}

/** Run the precheck shell command and map protocol → run | skip | error. */
