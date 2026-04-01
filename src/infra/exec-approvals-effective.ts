import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
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

export type ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> = {
  requested: TValue;
  requestedSource: string;
  host: TValue;
  hostSource: string;
  effective: TValue;
  note: string;
};

export type ExecPolicyScopeSummary = {
  scopeLabel: string;
  configPath: string;
  agentId?: string;
  security: ExecPolicyFieldSummary<ExecSecurity>;
  ask: ExecPolicyFieldSummary<ExecAsk>;
  askFallback: {
    effective: ExecSecurity;
    source: string;
  };
};

function formatRequestedSource(params: {
  path: string;
  field: "security" | "ask";
  explicit: boolean;
}): string {
  return params.explicit
    ? `${params.path}.${params.field}`
    : `OpenClaw default (${REQUESTED_DEFAULT_LABEL[params.field]})`;
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

export function resolveExecPolicyScopeSummary(params: {
  approvals: ExecApprovalsFile;
  execConfig?: { security?: ExecSecurity; ask?: ExecAsk } | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSummary {
  const requestedSecurity = params.execConfig?.security ?? DEFAULT_REQUESTED_SECURITY;
  const requestedAsk = params.execConfig?.ask ?? DEFAULT_REQUESTED_ASK;
  const resolved = resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: requestedSecurity,
      ask: requestedAsk,
    },
  });
  const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
  const effectiveSecurity = minSecurity(requestedSecurity, resolved.agent.security);
  const effectiveAsk =
    resolved.agent.ask === "off" ? "off" : maxAsk(requestedAsk, resolved.agent.ask);
  return {
    scopeLabel: params.scopeLabel,
    configPath: params.configPath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    security: {
      requested: requestedSecurity,
      requestedSource: formatRequestedSource({
        path: params.configPath,
        field: "security",
        explicit: params.execConfig?.security !== undefined,
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
        effectiveSecurity === requestedSecurity
          ? "requested security applies"
          : "stricter host security wins",
    },
    ask: {
      requested: requestedAsk,
      requestedSource: formatRequestedSource({
        path: params.configPath,
        field: "ask",
        explicit: params.execConfig?.ask !== undefined,
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
        requestedAsk,
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
  };
}
