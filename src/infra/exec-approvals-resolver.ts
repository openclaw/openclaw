// Resolves normalized exec approval policy without persistence side effects.
import {
  DEFAULT_ASK,
  DEFAULT_AUTO_ALLOW_SKILLS,
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  DEFAULT_SECURITY,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecAsk,
  ExecSecurity,
} from "./exec-approvals-core.js";
import { expandHomePrefix } from "./home-dir.js";

function isExecSecurity(value: unknown): value is ExecSecurity {
  return value === "allowlist" || value === "full" || value === "deny";
}

function isExecAsk(value: unknown): value is ExecAsk {
  return value === "always" || value === "off" || value === "on-miss";
}

function normalizeSecurity(value: unknown, fallback: ExecSecurity): ExecSecurity {
  return isExecSecurity(value) ? value : fallback;
}

function normalizeAsk(value: unknown, fallback: ExecAsk): ExecAsk {
  return isExecAsk(value) ? value : fallback;
}

type ResolvedExecPolicyField<TValue extends ExecSecurity | ExecAsk> = {
  value: TValue;
  source: string | null;
};

function resolveAgentPolicyField<TValue extends ExecSecurity | ExecAsk>(params: {
  field: "security" | "ask" | "askFallback";
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: TValue;
  isValid: (value: unknown) => value is TValue;
}): ResolvedExecPolicyField<TValue> {
  const defaultValue = params.defaults[params.field];
  const fallbackField = params.isValid(defaultValue)
    ? { value: defaultValue, source: `defaults.${params.field}` }
    : { value: params.fallback, source: null };
  if (params.rawAgent[params.field] != null) {
    const value = params.agent[params.field];
    return params.isValid(value)
      ? { value, source: `agents.${params.agentKey}.${params.field}` }
      : fallbackField;
  }
  if (params.rawWildcard[params.field] != null) {
    const value = params.wildcard[params.field];
    return params.isValid(value) ? { value, source: `agents.*.${params.field}` } : fallbackField;
  }
  return fallbackField;
}

export function resolveExecApprovalsFromFilePrepared(params: {
  rawFile: ExecApprovalsFile;
  file: ExecApprovalsFile;
  token: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
}): ExecApprovalsResolved {
  const rawFile = params.rawFile;
  const file = params.file;
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? "default";
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const rawAgent = rawFile.agents?.[agentKey] ?? {};
  const rawWildcard = rawFile.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolvedAgentSecurity = resolveAgentPolicyField({
    field: "security",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.security,
    isValid: isExecSecurity,
  });
  const resolvedAgentAsk = resolveAgentPolicyField({
    field: "ask",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.ask,
    isValid: isExecAsk,
  });
  const resolvedAgentAskFallback = resolveAgentPolicyField({
    field: "askFallback",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.askFallback,
    isValid: isExecSecurity,
  });
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsDisplayPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token,
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    agentSources: {
      security: resolvedAgentSecurity.source,
      ask: resolvedAgentAsk.source,
      askFallback: resolvedAgentAskFallback.source,
    },
    allowlist,
    file,
  };
}

export function resolveExecApprovalsFromFileInternal(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovalsInternal(params.file);
  const { token: socketToken } = file.socket ?? {};
  return resolveExecApprovalsFromFilePrepared({
    ...params,
    rawFile,
    file,
    token: params.token ?? socketToken ?? "",
  });
}
