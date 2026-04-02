import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals.js";

const DEFAULT_REQUESTED_SECURITY: ExecSecurity = "allowlist";
const DEFAULT_REQUESTED_ASK: ExecAsk = "on-miss";
const DEFAULT_HOST_PATH = "~/.openclaw/exec-approvals.json";
const REQUESTED_DEFAULT_LABEL = {
  security: DEFAULT_REQUESTED_SECURITY,
  ask: DEFAULT_REQUESTED_ASK,
} as const;
type ExecPolicyConfig = {
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export type ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> = {
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
  security: ExecPolicyFieldSummary<ExecSecurity>;
  ask: ExecPolicyFieldSummary<ExecAsk>;
  askFallback: {
    effective: ExecSecurity;
    source: string;
  };
  allowedDecisions: readonly ExecApprovalDecision[];
};

export type ExecPolicyScopeSummary = Omit<ExecPolicyScopeSnapshot, "allowedDecisions">;

type ExecPolicyRequestedField = "security" | "ask";

function formatRequestedSource(params: {
  sourcePath: string;
  field: "security" | "ask";
  defaultValue: ExecSecurity | ExecAsk;
}): string {
  return params.sourcePath === "__default__"
    ? `OpenClaw default (${params.defaultValue})`
    : `${params.sourcePath}.${params.field}`;
}

type ExecPolicyField = "security" | "ask" | "askFallback";

function readExecPolicyField(params: {
  field: ExecPolicyField;
  entry?: {
    security?: ExecSecurity;
    ask?: ExecAsk;
    askFallback?: ExecSecurity;
  };
}): ExecSecurity | ExecAsk | undefined {
  switch (params.field) {
    case "security":
      return params.entry?.security;
    case "ask":
      return params.entry?.ask;
    case "askFallback":
      return params.entry?.askFallback;
  }
}

function resolveRequestedField<TValue extends ExecSecurity | ExecAsk>(params: {
  field: ExecPolicyRequestedField;
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
}): { value: TValue; sourcePath: string } {
  const scopeValue = params.scopeExecConfig?.[params.field];
  if (scopeValue !== undefined) {
    return {
      value: scopeValue as TValue,
      sourcePath: params.field && "scope",
    };
  }
  const globalValue = params.globalExecConfig?.[params.field];
  if (globalValue !== undefined) {
    return {
      value: globalValue as TValue,
      sourcePath: "tools.exec",
    };
  }
  const defaultValue = REQUESTED_DEFAULT_LABEL[params.field] as TValue;
  return {
    value: defaultValue,
    sourcePath: "__default__",
  };
}

function resolveHostFieldSource(params: {
  hostPath: string;
  agentId?: string;
  field: ExecPolicyField;
  approvals: ExecApprovalsFile;
}): string {
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const explicitAgentEntry = params.approvals.agents?.[agentKey];
  if (readExecPolicyField({ field: params.field, entry: explicitAgentEntry }) !== undefined) {
    return `${params.hostPath} agents.${agentKey}.${params.field}`;
  }
  const wildcardEntry = params.approvals.agents?.["*"];
  if (readExecPolicyField({ field: params.field, entry: wildcardEntry }) !== undefined) {
    return `${params.hostPath} agents.*.${params.field}`;
  }
  if (
    readExecPolicyField({
      field: params.field,
      entry: params.approvals.defaults,
    }) !== undefined
  ) {
    return `${params.hostPath} defaults.${params.field}`;
  }
  if (params.field === "askFallback") {
    return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
  }
  return "inherits requested tool policy";
}

function resolveAskNote(params: {
  requestedAsk: ExecAsk;
  hostAsk: ExecAsk;
  effectiveAsk: ExecAsk;
}): string {
  if (params.hostAsk === "off" && params.requestedAsk !== "off") {
    return "host ask=off suppresses prompts";
  }
  if (params.effectiveAsk === params.requestedAsk) {
    return "requested ask applies";
  }
  return "more aggressive ask wins";
}

function formatHostSource(params: {
  hostPath: string;
  agentId?: string;
  field: ExecPolicyField;
  approvals: ExecApprovalsFile;
}): string {
  return resolveHostFieldSource(params);
}

export function collectExecPolicyScopeSnapshots(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
}): ExecPolicyScopeSnapshot[] {
  const snapshots = [
    resolveExecPolicyScopeSnapshot({
      approvals: params.approvals,
      scopeExecConfig: params.cfg.tools?.exec,
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    }),
  ];
  const globalExecConfig = params.cfg.tools?.exec;
  const configAgentIds = new Set(
    (params.cfg.agents?.list ?? [])
      .filter((agent) => agent.id !== DEFAULT_AGENT_ID || agent.tools?.exec !== undefined)
      .map((agent) => agent.id),
  );
  const approvalAgentIds = Object.keys(params.approvals.agents ?? {}).filter(
    (agentId) => agentId !== "*" && agentId !== "default" && agentId !== DEFAULT_AGENT_ID,
  );
  const agentIds = Array.from(new Set([...configAgentIds, ...approvalAgentIds])).toSorted();
  for (const agentId of agentIds) {
    const agentConfig = params.cfg.agents?.list?.find((agent) => agent.id === agentId);
    snapshots.push(
      resolveExecPolicyScopeSnapshot({
        approvals: params.approvals,
        scopeExecConfig: agentConfig?.tools?.exec,
        globalExecConfig,
        configPath: `agents.list.${agentId}.tools.exec`,
        scopeLabel: `agent:${agentId}`,
        agentId,
      }),
    );
  }
  return snapshots;
}

export function resolveExecPolicyScopeSummary(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSummary {
  const snapshot = resolveExecPolicyScopeSnapshot(params);
  const { allowedDecisions: _allowedDecisions, ...summary } = snapshot;
  return summary;
}

export function resolveExecPolicyScopeSnapshot(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSnapshot {
  const requestedSecurity = resolveRequestedField<ExecSecurity>({
    field: "security",
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
  });
  const requestedAsk = resolveRequestedField<ExecAsk>({
    field: "ask",
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
  });
  const resolved = resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: requestedSecurity.value,
      ask: requestedAsk.value,
    },
  });
  const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
  const effectiveSecurity = minSecurity(requestedSecurity.value, resolved.agent.security);
  const effectiveAsk =
    resolved.agent.ask === "off" ? "off" : maxAsk(requestedAsk.value, resolved.agent.ask);
  return {
    scopeLabel: params.scopeLabel,
    configPath: params.configPath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    security: {
      requested: requestedSecurity.value,
      requestedSource: formatRequestedSource({
        sourcePath:
          requestedSecurity.sourcePath === "scope"
            ? params.configPath
            : requestedSecurity.sourcePath,
        field: "security",
        defaultValue: DEFAULT_REQUESTED_SECURITY,
      }),
      host: resolved.agent.security,
      hostSource: formatHostSource({
        hostPath,
        agentId: params.agentId,
        field: "security",
        approvals: params.approvals,
      }),
      effective: effectiveSecurity,
      note:
        effectiveSecurity === requestedSecurity.value
          ? "requested security applies"
          : "stricter host security wins",
    },
    ask: {
      requested: requestedAsk.value,
      requestedSource: formatRequestedSource({
        sourcePath:
          requestedAsk.sourcePath === "scope" ? params.configPath : requestedAsk.sourcePath,
        field: "ask",
        defaultValue: DEFAULT_REQUESTED_ASK,
      }),
      host: resolved.agent.ask,
      hostSource: formatHostSource({
        hostPath,
        agentId: params.agentId,
        field: "ask",
        approvals: params.approvals,
      }),
      effective: effectiveAsk,
      note: resolveAskNote({
        requestedAsk: requestedAsk.value,
        hostAsk: resolved.agent.ask,
        effectiveAsk,
      }),
    },
    askFallback: {
      effective: resolved.agent.askFallback,
      source: formatHostSource({
        hostPath,
        agentId: params.agentId,
        field: "askFallback",
        approvals: params.approvals,
      }),
    },
    allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk }),
  };
}
