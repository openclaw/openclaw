// Resolves exec approval policy and approval-decision availability.
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import type { AllowAlwaysPersistenceDecision } from "./exec-approvals-allow-always.js";
import {
  DEFAULT_ASK,
  DEFAULT_AUTO_ALLOW_SKILLS,
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  DEFAULT_SECURITY,
  normalizeExecApprovals,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import {
  normalizeExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalUnavailableDecision,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals-core.js";
import { withExecApprovalsReadLock, withExecApprovalsReadLockSync } from "./exec-approvals-lock.js";
import {
  ensureExecApprovals,
  ensureExecApprovalsSnapshot,
  readExecApprovalsForNoPersistenceUnlocked,
} from "./exec-approvals-store.js";
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

function resolveDefaultSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const defaultValue = params.defaults[params.field];
  if (isExecSecurity(defaultValue)) {
    return {
      value: defaultValue,
      source: `defaults.${params.field}`,
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveDefaultAskField(params: {
  defaults: ExecApprovalsDefaults;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  if (isExecAsk(params.defaults.ask)) {
    return {
      value: params.defaults.ask,
      source: "defaults.ask",
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveAgentSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const fallbackField = resolveDefaultSecurityField({
    field: params.field,
    defaults: params.defaults,
    fallback: params.fallback,
  });
  const rawAgentValue = params.rawAgent[params.field];
  if (rawAgentValue != null) {
    if (isExecSecurity(params.agent[params.field])) {
      return {
        value: params.agent[params.field] as ExecSecurity,
        source: `agents.${params.agentKey}.${params.field}`,
      };
    }
    return fallbackField;
  }
  const rawWildcardValue = params.rawWildcard[params.field];
  if (rawWildcardValue != null) {
    if (isExecSecurity(params.wildcard[params.field])) {
      return {
        value: params.wildcard[params.field] as ExecSecurity,
        source: `agents.*.${params.field}`,
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

function resolveAgentAskField(params: {
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  const fallbackField = resolveDefaultAskField({
    defaults: params.defaults,
    fallback: params.fallback,
  });
  if (params.rawAgent.ask != null) {
    if (isExecAsk(params.agent.ask)) {
      return {
        value: params.agent.ask,
        source: `agents.${params.agentKey}.ask`,
      };
    }
    return fallbackField;
  }
  if (params.rawWildcard.ask != null) {
    if (isExecAsk(params.wildcard.ask)) {
      return {
        value: params.wildcard.ask,
        source: "agents.*.ask",
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  requireSocket?: boolean;
};

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

function resolveExecApprovalsWithoutSocket(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
}): ExecApprovalsResolved | null {
  const resolved = shapeResolvedExecApprovals({ ...params, socket: "none" });
  const noPrompt =
    (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
    resolved.agent.ask === "off";
  return noPrompt && !params.file.socket?.token?.trim() ? resolved : null;
}

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = withExecApprovalsReadLockSync(filePath, () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  const file = ensureExecApprovals();
  return shapeResolvedExecApprovals({
    file,
    filePath,
    agentId,
    overrides,
    socket: "persisted",
  });
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = await withExecApprovalsReadLock(filePath, async () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
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
  const resolvedAgentSecurity = resolveAgentSecurityField({
    field: "security",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.security,
  });
  const resolvedAgentAsk = resolveAgentAskField({
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.ask,
  });
  const resolvedAgentAskFallback = resolveAgentSecurityField({
    field: "askFallback",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.askFallback,
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
    path: params.path ?? resolveExecApprovalsPath(),
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

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

function normalizeCommandName(value: string | undefined): string {
  return (value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  let offset = command === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
  if (normalizeCommandName(argv[offset]) !== "openclaw") {
    return false;
  }
  offset += 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (["--dev", "--no-color"].includes(arg ?? "")) {
      offset += 1;
      continue;
    }
    if (["--profile", "--container", "--log-level"].includes(arg ?? "")) {
      offset += 2;
      continue;
    }
    if (
      arg?.startsWith("--profile=") ||
      arg?.startsWith("--container=") ||
      arg?.startsWith("--log-level=")
    ) {
      offset += 1;
      continue;
    }
    break;
  }
  return (
    argv[offset] === "config" && ["get", "schema", "validate"].includes(argv[offset + 1] ?? "")
  );
}

function removeParsedSegmentText(
  command: string,
  segments: Array<{ argv?: string[]; raw?: string }>,
): string {
  let remaining = command;
  for (const segment of segments) {
    const raw = (segment.raw ?? segment.argv?.join(" "))?.trim();
    if (!raw) {
      continue;
    }
    remaining = remaining.replace(raw, " ");
  }
  return remaining;
}

export function commandRequiresSecurityAuditSuppressionApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  segments: Array<{ argv: string[]; raw?: string }>;
}): boolean {
  let sawSegmentMention = false;
  for (const segment of params.segments) {
    const segmentText = `${segment.raw ?? ""} ${segment.argv.join(" ")}`;
    if (!textMentionsSecurityAuditSuppressions(segmentText)) {
      continue;
    }
    sawSegmentMention = true;
    if (!isReadOnlySecurityAuditSuppressionInspection(segment.argv)) {
      return true;
    }
  }
  if (sawSegmentMention) {
    const unparsedText = removeParsedSegmentText(params.command, params.segments);
    if (textMentionsSecurityAuditSuppressions(unparsedText)) {
      return true;
    }
    return false;
  }
  return textMentionsSecurityAuditSuppressions(params.command);
}

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
export const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}

export function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean {
  return resolveExecApprovalAllowedDecisions({ ask: params.ask }).includes(params.decision);
}
