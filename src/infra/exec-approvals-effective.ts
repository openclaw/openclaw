// Resolves effective exec approval policy from config and policy files.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listAgentEntries,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecToolConfig } from "../config/types.tools.js";
import {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsDisplayPath,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
} from "./exec-approvals.js";

const DEFAULT_REQUESTED_SECURITY: ExecSecurity = "full";
const DEFAULT_REQUESTED_ASK: ExecAsk = "off";
export const SESSION_EXEC_OVERRIDES_NOTE =
  "Per-session /exec overrides are not included; run /exec in the relevant session to inspect its current defaults.";
type ExecPolicyConfig = Pick<ExecToolConfig, "host" | "mode" | "security" | "ask">;

export type ExecPolicyScopeSnapshot = ReturnType<typeof resolveExecPolicyScopeSnapshot>;

function resolveRequestedField<TValue extends string>(params: {
  scopeValue?: TValue;
  globalValue?: TValue;
  fallback: TValue;
  scopeSource: string;
  globalSource: string;
}): { value: TValue; source: string } {
  if (params.scopeValue !== undefined) {
    return { value: params.scopeValue, source: params.scopeSource };
  }
  if (params.globalValue !== undefined) {
    return { value: params.globalValue, source: params.globalSource };
  }
  return { value: params.fallback, source: `OpenClaw default (${params.fallback})` };
}

type ExecPolicyField = "security" | "ask" | "askFallback";
type ExecPolicyHostDefaults = Pick<
  Required<ExecApprovalsDefaults>,
  "security" | "ask" | "askFallback"
>;

function hasLegacyExecPolicyOverride(exec?: ExecPolicyConfig): boolean {
  return exec?.security !== undefined || exec?.ask !== undefined;
}

function resolveRequestedPolicy(params: {
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
  configPath: string;
}) {
  const explicitMode =
    params.scopeExecConfig?.mode ||
    (!hasLegacyExecPolicyOverride(params.scopeExecConfig)
      ? params.globalExecConfig?.mode
      : undefined);
  if (explicitMode) {
    const policy = resolveExecModePolicy({
      mode: explicitMode,
      security: DEFAULT_REQUESTED_SECURITY,
      ask: DEFAULT_REQUESTED_ASK,
    });
    const source = `${params.scopeExecConfig?.mode ? params.configPath : "tools.exec"}.mode`;
    return {
      mode: policy.mode,
      modeSource: source,
      security: policy.security,
      securitySource: source,
      ask: policy.ask,
      askSource: source,
    };
  }
  const inherited = params.globalExecConfig?.mode
    ? resolveExecModePolicy({
        mode: params.globalExecConfig.mode,
        security: DEFAULT_REQUESTED_SECURITY,
        ask: DEFAULT_REQUESTED_ASK,
      })
    : undefined;
  const security = resolveRequestedField<ExecSecurity>({
    scopeValue: params.scopeExecConfig?.security,
    globalValue: inherited?.security ?? params.globalExecConfig?.security,
    fallback: DEFAULT_REQUESTED_SECURITY,
    scopeSource: `${params.configPath}.security`,
    globalSource: inherited ? "tools.exec.mode" : "tools.exec.security",
  });
  const ask = resolveRequestedField<ExecAsk>({
    scopeValue: params.scopeExecConfig?.ask,
    globalValue: inherited?.ask ?? params.globalExecConfig?.ask,
    fallback: DEFAULT_REQUESTED_ASK,
    scopeSource: `${params.configPath}.ask`,
    globalSource: inherited ? "tools.exec.mode" : "tools.exec.ask",
  });
  return {
    mode: resolveExecModeFromPolicy({ security: security.value, ask: ask.value }),
    modeSource:
      security.source === ask.source
        ? `derived from ${security.source}`
        : `derived from ${security.source} and ${ask.source}`,
    security: security.value,
    securitySource: security.source,
    ask: ask.value,
    askSource: ask.source,
  };
}

export function collectExecPolicyScopeSnapshots(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
  hostPath?: string;
  hostDefaults?: ExecPolicyHostDefaults;
  hostDefaultSource?: string;
}): ExecPolicyScopeSnapshot[] {
  const defaultAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);
  const snapshots = [
    resolveExecPolicyScopeSnapshot({
      approvals: params.approvals,
      agentId: defaultAgentId,
      scopeExecConfig: params.cfg.tools?.exec,
      configPath: "tools.exec",
      hostPath: params.hostPath,
      hostDefaults: params.hostDefaults,
      hostDefaultSource: params.hostDefaultSource,
      scopeLabel: "tools.exec",
    }),
  ];
  const globalExecConfig = params.cfg.tools?.exec;
  const configuredAgents = listAgentEntries(params.cfg);
  const configAgentIds = new Set(
    configuredAgents
      .filter((agent) => agent.id !== defaultAgentId || agent.tools?.exec !== undefined)
      .map((agent) => agent.id),
  );
  const approvalAgentIds = Object.keys(params.approvals.agents ?? {}).filter(
    (agentId) => agentId !== "*" && agentId !== "default" && agentId !== defaultAgentId,
  );
  const agentIds = sortUniqueStrings([...configAgentIds, ...approvalAgentIds]);
  for (const agentId of agentIds) {
    const agentConfig = configuredAgents.find((agent) => agent.id === agentId);
    snapshots.push(
      resolveExecPolicyScopeSnapshot({
        approvals: params.approvals,
        scopeExecConfig: agentConfig?.tools?.exec,
        globalExecConfig,
        configPath: `agents.entries.${agentId}.tools.exec`,
        hostPath: params.hostPath,
        hostDefaults: params.hostDefaults,
        hostDefaultSource: params.hostDefaultSource,
        scopeLabel: `agent:${agentId}`,
        agentId,
      }),
    );
  }
  return snapshots;
}

export function resolveExecPolicyScopeSnapshot(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
  hostDefaults?: ExecPolicyHostDefaults;
  hostDefaultSource?: string;
}) {
  const requestedHost = resolveRequestedField<ExecTarget>({
    scopeValue: params.scopeExecConfig?.host,
    globalValue: params.globalExecConfig?.host,
    fallback: "auto",
    scopeSource: `${params.configPath}.host`,
    globalSource: "tools.exec.host",
  });
  const requestedPolicy = resolveRequestedPolicy({
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
    configPath: params.configPath,
  });
  const resolved = resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: params.hostDefaults?.security ?? requestedPolicy.security,
      ask: params.hostDefaults?.ask ?? requestedPolicy.ask,
      ...(params.hostDefaults ? { askFallback: params.hostDefaults.askFallback } : {}),
    },
  });
  const hostPath = params.hostPath ?? resolveExecApprovalsDisplayPath();
  const formatHostFieldSource = (field: ExecPolicyField, sourceSuffix: string | null): string => {
    if (sourceSuffix) {
      return `${hostPath} ${sourceSuffix}`;
    }
    if (params.hostDefaultSource) {
      return params.hostDefaultSource;
    }
    if (field === "askFallback") {
      return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
    }
    return "inherits requested tool policy";
  };
  const effectiveSecurity = minSecurity(requestedPolicy.security, resolved.agent.security);
  const effectiveAsk = maxAsk(requestedPolicy.ask, resolved.agent.ask);
  const effectiveAskFallback = minSecurity(effectiveSecurity, resolved.agent.askFallback);
  const effectiveMode =
    effectiveSecurity === requestedPolicy.security && effectiveAsk === requestedPolicy.ask
      ? requestedPolicy.mode
      : resolveExecModeFromPolicy({
          security: effectiveSecurity,
          ask: effectiveAsk,
        });
  return {
    scopeLabel: params.scopeLabel,
    configPath: params.configPath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    host: {
      requested: requestedHost.value,
      requestedSource: requestedHost.source,
    },
    mode: {
      requested: requestedPolicy.mode,
      requestedSource: requestedPolicy.modeSource,
      effective: effectiveMode,
      note:
        effectiveMode === requestedPolicy.mode
          ? "requested mode applies"
          : "host policy changes effective mode",
    },
    security: {
      requested: requestedPolicy.security,
      requestedSource: requestedPolicy.securitySource,
      host: resolved.agent.security,
      hostSource: formatHostFieldSource("security", resolved.agentSources.security),
      effective: effectiveSecurity,
      note:
        effectiveSecurity === requestedPolicy.security
          ? "requested security applies"
          : "stricter host security wins",
    },
    ask: {
      requested: requestedPolicy.ask,
      requestedSource: requestedPolicy.askSource,
      host: resolved.agent.ask,
      hostSource: formatHostFieldSource("ask", resolved.agentSources.ask),
      effective: effectiveAsk,
      note:
        effectiveAsk === requestedPolicy.ask ? "requested ask applies" : "more aggressive ask wins",
    },
    askFallback: {
      effective: effectiveAskFallback,
      source: formatHostFieldSource("askFallback", resolved.agentSources.askFallback),
    },
    allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk }),
  };
}
