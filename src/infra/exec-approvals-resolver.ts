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
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
} from "./exec-approvals-core.js";
import { expandHomePrefix } from "./home-dir.js";

export function resolveExecApprovalsFromFileInternal(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovalsInternal(rawFile);
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
    security: defaults.security ?? fallbackSecurity,
    ask: defaults.ask ?? fallbackAsk,
    askFallback: defaults.askFallback ?? fallbackAskFallback,
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolveField = <TField extends "security" | "ask" | "askFallback">(
    field: TField,
  ): { value: Required<ExecApprovalsDefaults>[TField]; source: string | null } => {
    const defaultValue = defaults[field];
    const fallbackField =
      defaultValue !== undefined
        ? { value: defaultValue, source: `defaults.${field}` }
        : { value: resolvedDefaults[field], source: null };
    const agentOverrides = rawAgent[field] != null;
    const policy: ExecApprovalsDefaults | undefined = agentOverrides
      ? agent
      : rawWildcard[field] != null
        ? wildcard
        : undefined;
    const value = policy?.[field];
    return value !== undefined
      ? { value, source: `agents.${agentOverrides ? agentKey : "*"}.${field}` }
      : fallbackField;
  };
  const resolvedAgentSecurity = resolveField("security");
  const resolvedAgentAsk = resolveField("ask");
  const resolvedAgentAskFallback = resolveField("askFallback");
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [...(wildcard.allowlist ?? []), ...(agent.allowlist ?? [])];
  return {
    path: params.path ?? resolveExecApprovalsDisplayPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
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
