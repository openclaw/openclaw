// Resolves effective exec approval policy from config and policy files.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listAgentEntries,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsDisplayPath,
  type ExecApprovalDecision,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
} from "./exec-approvals.js";

const DEFAULT_REQUESTED_SECURITY: ExecSecurity = "full";
const DEFAULT_REQUESTED_ASK: ExecAsk = "off";
export const SESSION_EXEC_OVERRIDES_NOTE =
  "Per-session /exec overrides are not included; run /exec in the relevant session to inspect its current defaults.";
type ExecPolicyConfig = {
  host?: ExecTarget;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

type ExecPolicyHostSummary = {
  requested: ExecTarget;
  requestedSource: string;
};

type ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> = {
  requested: TValue;
  requestedSource: string;
  host: TValue;
  hostSource: string;
  effective: TValue;
  note: string;
};

export type ExecPolicyScopeSnapshot = {
  scopeLabel: string;
  configPath: string;
  agentId?: string;
  host: ExecPolicyHostSummary;
  mode: {
    requested: ExecMode;
    requestedSource: string;
    effective: ExecMode;
    note: string;
  };
  security: ExecPolicyFieldSummary<ExecSecurity>;
  ask: ExecPolicyFieldSummary<ExecAsk>;
  askFallback: {
    effective: ExecSecurity;
    source: string;
  };
  allowedDecisions: readonly ExecApprovalDecision[];
};

function resolveRequestedField<TValue>(params: {
  scopeValue?: TValue;
  globalValue?: TValue;
  fallback: TValue;
}): { value: TValue; sourcePath: string } {
  if (params.scopeValue !== undefined) {
    return { value: params.scopeValue, sourcePath: "scope" };
  }
  if (params.globalValue !== undefined) {
    return { value: params.globalValue, sourcePath: "tools.exec" };
  }
  return { value: params.fallback, sourcePath: "__default__" };
}

function formatRequestedSource(params: {
  sourcePath: string;
  field: "security" | "ask";
  defaultValue: ExecSecurity | ExecAsk;
}): string {
  return params.sourcePath === "__default__"
    ? `OpenClaw default (${params.defaultValue})`
    : `${params.sourcePath}.${params.field}`;
}

function formatModeSource(params: { sourcePath: string; configPath: string }): string {
  if (params.sourcePath === "__default__") {
    return "derived from OpenClaw defaults";
  }
  return `${params.sourcePath === "scope" ? params.configPath : params.sourcePath}.mode`;
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
}): {
  mode: ExecMode;
  modeSource: string;
  security: ExecSecurity;
  securitySource: string;
  ask: ExecAsk;
  askSource: string;
} {
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
    const source = formatModeSource({
      sourcePath: params.scopeExecConfig?.mode ? "scope" : "tools.exec",
      configPath: params.configPath,
    });
    return {
      mode: policy.mode,
      modeSource: source,
      security: policy.security,
      securitySource: source,
      ask: policy.ask,
      askSource: source,
    };
  }
  if (hasLegacyExecPolicyOverride(params.scopeExecConfig) && params.globalExecConfig?.mode) {
    const inherited = resolveExecModePolicy({
      mode: params.globalExecConfig.mode,
      security: DEFAULT_REQUESTED_SECURITY,
      ask: DEFAULT_REQUESTED_ASK,
    });
    const inheritedSource = formatModeSource({
      sourcePath: "tools.exec",
      configPath: params.configPath,
    });
    const scopeSecuritySource = formatRequestedSource({
      sourcePath: params.configPath,
      field: "security",
      defaultValue: DEFAULT_REQUESTED_SECURITY,
    });
    const scopeAskSource = formatRequestedSource({
      sourcePath: params.configPath,
      field: "ask",
      defaultValue: DEFAULT_REQUESTED_ASK,
    });
    const security = params.scopeExecConfig?.security ?? inherited.security;
    const ask = params.scopeExecConfig?.ask ?? inherited.ask;
    const securitySource =
      params.scopeExecConfig?.security !== undefined ? scopeSecuritySource : inheritedSource;
    const askSource = params.scopeExecConfig?.ask !== undefined ? scopeAskSource : inheritedSource;
    return {
      mode: resolveExecModeFromPolicy({ security, ask }),
      modeSource:
        securitySource === askSource
          ? `derived from ${securitySource}`
          : `derived from ${securitySource} and ${askSource}`,
      security,
      securitySource,
      ask,
      askSource,
    };
  }

  const security = resolveRequestedField<ExecSecurity>({
    scopeValue: params.scopeExecConfig?.security,
    globalValue: params.globalExecConfig?.security,
    fallback: DEFAULT_REQUESTED_SECURITY,
  });
  const ask = resolveRequestedField<ExecAsk>({
    scopeValue: params.scopeExecConfig?.ask,
    globalValue: params.globalExecConfig?.ask,
    fallback: DEFAULT_REQUESTED_ASK,
  });
  const securitySource = formatRequestedSource({
    sourcePath: security.sourcePath === "scope" ? params.configPath : security.sourcePath,
    field: "security",
    defaultValue: DEFAULT_REQUESTED_SECURITY,
  });
  const askSource = formatRequestedSource({
    sourcePath: ask.sourcePath === "scope" ? params.configPath : ask.sourcePath,
    field: "ask",
    defaultValue: DEFAULT_REQUESTED_ASK,
  });
  return {
    mode: resolveExecModeFromPolicy({ security: security.value, ask: ask.value }),
    modeSource:
      securitySource === askSource
        ? `derived from ${securitySource}`
        : `derived from ${securitySource} and ${askSource}`,
    security: security.value,
    securitySource,
    ask: ask.value,
    askSource,
  };
}

function formatHostFieldSource(params: {
  hostPath: string;
  field: ExecPolicyField;
  sourceSuffix: string | null;
  hostDefaultSource?: string;
}): string {
  if (params.sourceSuffix) {
    return `${params.hostPath} ${params.sourceSuffix}`;
  }
  if (params.hostDefaultSource) {
    return params.hostDefaultSource;
  }
  if (params.field === "askFallback") {
    return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
  }
  return "inherits requested tool policy";
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
}): ExecPolicyScopeSnapshot {
  const requestedHost = resolveRequestedField<ExecTarget>({
    scopeValue: params.scopeExecConfig?.host,
    globalValue: params.globalExecConfig?.host,
    fallback: "auto",
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
      requestedSource:
        requestedHost.sourcePath === "__default__"
          ? "OpenClaw default (auto)"
          : `${requestedHost.sourcePath === "scope" ? params.configPath : requestedHost.sourcePath}.host`,
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
      hostSource: formatHostFieldSource({
        hostPath,
        field: "security",
        sourceSuffix: resolved.agentSources.security,
        hostDefaultSource: params.hostDefaultSource,
      }),
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
      hostSource: formatHostFieldSource({
        hostPath,
        field: "ask",
        sourceSuffix: resolved.agentSources.ask,
        hostDefaultSource: params.hostDefaultSource,
      }),
      effective: effectiveAsk,
      note:
        effectiveAsk === requestedPolicy.ask ? "requested ask applies" : "more aggressive ask wins",
    },
    askFallback: {
      effective: effectiveAskFallback,
      source: formatHostFieldSource({
        hostPath,
        field: "askFallback",
        sourceSuffix: resolved.agentSources.askFallback,
        hostDefaultSource: params.hostDefaultSource,
      }),
    },
    allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk }),
  };
}
