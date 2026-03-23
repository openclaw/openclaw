import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logWarn } from "../logger.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { expandHomePrefix } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";

const warnedLegacyAllowlistAgents = new Set<string>();

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export type SystemRunApprovalBinding = {
  argv: string[];
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  envHash: string | null;
};

export type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;
};

export type SystemRunApprovalPlan = {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId: string | null;
  sessionKey: string | null;
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};

export type ExecApprovalRequestPayload = {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  // Optional UI-safe env key preview for approval prompts.
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ExecApprovalRequest["request"];
};

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export type ExecAllowlistEntry = {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

/**
 * Per-host allowlist map. Keys are exec host names ("sandbox", "gateway", "node")
 * plus the reserved key "default" which applies when no host-specific entry exists.
 *
 * Legacy array format is treated as `{ "default": [...] }` at load time.
 */
export type ExecAllowlistByHost = Record<string, ExecAllowlistEntry[]>;

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  /**
   * Allowlist entries for this agent.
   * - Array: legacy format — treated as `{ "default": [...] }` (backward-compatible).
   * - Object (ExecAllowlistByHost): per-host format. Keys: "sandbox", "gateway", "node", "default".
   */
  allowlist?: ExecAllowlistEntry[] | ExecAllowlistByHost;
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};

export type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  /** Resolved allowlist for the default/legacy host. Use resolveAllowlistForHost() for per-host. */
  allowlist: ExecAllowlistEntry[];
  /** Raw per-host allowlist map (null if agent uses legacy array format or no allowlist). */
  allowlistByHost: ExecAllowlistByHost | null;
  file: ExecApprovalsFile;
};

/**
 * Resolve the effective allowlist for a specific exec host.
 * Falls back to "default" key, then to the flat allowlist (legacy).
 */
export function resolveAllowlistForHost(
  resolved: ExecApprovalsResolved,
  host: ExecHost,
): ExecAllowlistEntry[] {
  if (resolved.allowlistByHost) {
    // Use explicit undefined check: an empty array [] is a valid explicit bucket
    // and should NOT fall back to "default". Only absent keys fall back.
    const hostBucket = resolved.allowlistByHost[host];
    if (hostBucket !== undefined) {
      return hostBucket;
    }
    // Fall back to flat allowlist (legacy entries) when neither host nor "default" bucket exists.
    return resolved.allowlistByHost["default"] ?? resolved.allowlist;
  }
  return resolved.allowlist;
}

// Keep CLI + gateway defaults in sync.
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000;

const DEFAULT_SECURITY: ExecSecurity = "deny";
const DEFAULT_ASK: ExecAsk = "on-miss";
const DEFAULT_ASK_FALLBACK: ExecSecurity = "deny";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_SOCKET = "~/.openclaw/exec-approvals.sock";
const DEFAULT_FILE = "~/.openclaw/exec-approvals.json";

function hashExecApprovalsRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function resolveExecApprovalsPath(): string {
  return expandHomePrefix(DEFAULT_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return expandHomePrefix(DEFAULT_SOCKET);
}

function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const key = normalizeAllowlistPattern(entry.pattern);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    allowlist.push(entry);
  };
  // If current already uses map format, preserve it — merge legacy flat entries into "default".
  if (isAllowlistByHost(current.allowlist)) {
    const legacyEntries = Array.isArray(legacy.allowlist) ? legacy.allowlist : [];
    if (legacyEntries.length === 0) {
      return {
        security: current.security ?? legacy.security,
        ask: current.ask ?? legacy.ask,
        askFallback: current.askFallback ?? legacy.askFallback,
        autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
        allowlist: current.allowlist,
      };
    }
    const byHost = { ...current.allowlist };
    const defaultBucket = byHost["default"] ?? [];
    const seen = new Set(defaultBucket.map((e) => normalizeAllowlistPattern(e.pattern)));
    const merged = [...defaultBucket];
    for (const entry of legacyEntries) {
      const key = normalizeAllowlistPattern(entry.pattern);
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
    return {
      security: current.security ?? legacy.security,
      ask: current.ask ?? legacy.ask,
      askFallback: current.askFallback ?? legacy.askFallback,
      autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
      allowlist: { ...byHost, default: merged },
    };
  }

  const currentEntries = Array.isArray(current.allowlist) ? current.allowlist : [];
  const legacyEntries = Array.isArray(legacy.allowlist) ? legacy.allowlist : [];
  for (const entry of currentEntries) {
    pushEntry(entry);
  }
  for (const entry of legacyEntries) {
    pushEntry(entry);
  }

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
function coerceAllowlistEntries(allowlist: unknown): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return Array.isArray(allowlist) ? (allowlist as ExecAllowlistEntry[]) : undefined;
  }
  let changed = false;
  const result: ExecAllowlistEntry[] = [];
  for (const item of allowlist) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        result.push({ pattern: trimmed });
        changed = true;
      } else {
        changed = true; // dropped empty string
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const pattern = (item as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern.trim().length > 0) {
        result.push(item as ExecAllowlistEntry);
      } else {
        changed = true; // dropped invalid entry
      }
    } else {
      changed = true; // dropped invalid entry
    }
  }
  return changed ? (result.length > 0 ? result : undefined) : (allowlist as ExecAllowlistEntry[]);
}

function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) {
      return entry;
    }
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });
  return changed ? next : allowlist;
}

/**
 * Detect whether an allowlist value is the per-host map format (object with string-array values).
 * Returns false for arrays (legacy) and nullish.
 */
function isAllowlistByHost(value: unknown): value is ExecAllowlistByHost {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => Array.isArray(v))
  );
}

/**
 * Coerce and normalize per-host allowlist entries (ids, string→object, etc.).
 */
function normalizeAllowlistByHost(byHost: ExecAllowlistByHost): ExecAllowlistByHost {
  const result: ExecAllowlistByHost = {};
  let changed = false;
  for (const [hostKey, entries] of Object.entries(byHost)) {
    const coerced = coerceAllowlistEntries(entries);
    const withIds = ensureAllowlistIds(coerced);
    if (withIds !== entries) {
      changed = true;
    }
    result[hostKey] = withIds ?? [];
  }
  return changed ? result : byHost;
}

export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  const agents = { ...file.agents };
  const legacyDefault = agents.default;
  if (legacyDefault) {
    const main = agents[DEFAULT_AGENT_ID];
    agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
    delete agents.default;
  }
  for (const [key, agent] of Object.entries(agents)) {
    if (isAllowlistByHost(agent.allowlist)) {
      // Per-host map format: normalize each host's entries.
      const normalized = normalizeAllowlistByHost(agent.allowlist);
      if (normalized !== agent.allowlist) {
        agents[key] = { ...agent, allowlist: normalized };
      }
    } else {
      // Legacy array format (or undefined): normalize as flat list.
      if (Array.isArray(agent.allowlist) && !warnedLegacyAllowlistAgents.has(key)) {
        warnedLegacyAllowlistAgents.add(key);
        logWarn(
          `exec-approvals: agent "${key}" uses legacy array allowlist format — run "openclaw doctor" to migrate`,
        );
      }
      const coerced = coerceAllowlistEntries(agent.allowlist);
      const allowlist = ensureAllowlistIds(coerced);
      if (allowlist !== agent.allowlist) {
        agents[key] = { ...agent, allowlist };
      }
    }
  }
  const normalized: ExecApprovalsFile = {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      security: file.defaults?.security,
      ask: file.defaults?.ask,
      askFallback: file.defaults?.askFallback,
      autoAllowSkills: file.defaults?.autoAllowSkills,
    },
    agents,
  };
  return normalized;
}

export function mergeExecApprovalsSocketDefaults(params: {
  normalized: ExecApprovalsFile;
  current?: ExecApprovalsFile;
}): ExecApprovalsFile {
  const currentSocketPath = params.current?.socket?.path?.trim();
  const currentToken = params.current?.socket?.token?.trim();
  const socketPath =
    params.normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
  const token = params.normalized.socket?.token?.trim() ?? currentToken ?? "";
  return {
    ...params.normalized,
    socket: {
      path: socketPath,
      token,
    },
  };
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  if (!fs.existsSync(filePath)) {
    const file = normalizeExecApprovals({ version: 1, agents: {} });
    return {
      path: filePath,
      exists: false,
      raw: null,
      file,
      hash: hashExecApprovalsRaw(null),
    };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: ExecApprovalsFile | null = null;
  try {
    parsed = JSON.parse(raw) as ExecApprovalsFile;
  } catch {
    parsed = null;
  }
  const file =
    parsed?.version === 1
      ? normalizeExecApprovals(parsed)
      : normalizeExecApprovals({ version: 1, agents: {} });
  return {
    path: filePath,
    exists: true,
    raw,
    file,
    hash: hashExecApprovalsRaw(raw),
  };
}

export function loadExecApprovals(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ExecApprovalsFile;
    if (parsed?.version !== 1) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    return normalizeExecApprovals(parsed);
  } catch {
    return normalizeExecApprovals({ version: 1, agents: {} });
  }
}

export function saveExecApprovals(file: ExecApprovalsFile) {
  const filePath = resolveExecApprovalsPath();
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

export function ensureExecApprovals(): ExecApprovalsFile {
  const loaded = loadExecApprovals();
  const next = normalizeExecApprovals(loaded);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  const updated: ExecApprovalsFile = {
    ...next,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : resolveExecApprovalsSocketPath(),
      token: token && token.length > 0 ? token : generateToken(),
    },
  };
  saveExecApprovals(updated);
  return updated;
}

function normalizeSecurity(value: ExecSecurity | undefined, fallback: ExecSecurity): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return fallback;
}

function normalizeAsk(value: ExecAsk | undefined, fallback: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return fallback;
}

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const file = ensureExecApprovals();
  return resolveExecApprovalsFromFile({
    file,
    agentId,
    overrides,
    path: resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(file.socket?.path ?? resolveExecApprovalsSocketPath()),
    token: file.socket?.token ?? "",
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
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? fallbackAutoAllowSkills),
  };
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(
      agent.security ?? wildcard.security ?? resolvedDefaults.security,
      resolvedDefaults.security,
    ),
    ask: normalizeAsk(agent.ask ?? wildcard.ask ?? resolvedDefaults.ask, resolvedDefaults.ask),
    askFallback: normalizeSecurity(
      agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback,
      resolvedDefaults.askFallback,
    ),
    autoAllowSkills: Boolean(
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
    ),
  };
  // Resolve flat allowlist (legacy path: wildcard + agent array entries merged).
  // For map-format allowlists, use the "default" bucket as the flat fallback so that
  // legacy consumers (node-host allowlist checks) still see the applicable entries.
  const wildcardFlatList = Array.isArray(wildcard.allowlist)
    ? wildcard.allowlist
    : isAllowlistByHost(wildcard.allowlist)
      ? (wildcard.allowlist["default"] ?? [])
      : [];
  const agentFlatList = Array.isArray(agent.allowlist)
    ? agent.allowlist
    : isAllowlistByHost(agent.allowlist)
      ? (agent.allowlist["default"] ?? [])
      : [];
  const allowlist = [...wildcardFlatList, ...agentFlatList];

  // Resolve per-host allowlist map (new format).
  // If agent has a map format, build a merged map (wildcard flat entries go into "default").
  let allowlistByHost: ExecAllowlistByHost | null = null;
  const agentByHost = isAllowlistByHost(agent.allowlist) ? agent.allowlist : null;
  const wildcardByHost = isAllowlistByHost(wildcard.allowlist) ? wildcard.allowlist : null;
  if (agentByHost || wildcardByHost) {
    const mergedHosts = new Set<string>([
      ...Object.keys(agentByHost ?? {}),
      ...Object.keys(wildcardByHost ?? {}),
    ]);
    allowlistByHost = {};
    for (const hostKey of mergedHosts) {
      // For map-format wildcard: fall back to the wildcard "default" bucket, then to the flat list.
      const wildcardEntries =
        wildcardByHost?.[hostKey] ?? wildcardByHost?.["default"] ?? wildcardFlatList;
      // Fall back to agent "default" bucket or flat list when host-specific bucket is absent.
      const agentEntries = agentByHost?.[hostKey] ?? agentByHost?.["default"] ?? agentFlatList;
      const seen = new Set<string>();
      const merged: ExecAllowlistEntry[] = [];
      for (const e of [...wildcardEntries, ...agentEntries]) {
        const key = normalizeAllowlistPattern(e.pattern);
        if (key && !seen.has(key)) {
          seen.add(key);
          merged.push(e);
        }
      }
      allowlistByHost[hostKey] = merged;
    }
  }

  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    allowlist,
    allowlistByHost,
    file,
  };
}

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" &&
      params.security === "allowlist" &&
      (!params.analysisOk || !params.allowlistSatisfied))
  );
}

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
  host?: ExecHost,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};

  const updateEntry = (item: ExecAllowlistEntry) =>
    item.pattern === entry.pattern
      ? {
          ...item,
          id: item.id ?? crypto.randomUUID(),
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        }
      : item;

  if (isAllowlistByHost(existing.allowlist)) {
    if (!host) {
      // No host provided — cannot safely update a per-host map. Skip to avoid corruption.
      return;
    }
    // Per-host map: update the specific host bucket (or "default" fallback).
    const byHost = existing.allowlist;
    const bucket = byHost[host] !== undefined ? host : "default";
    const entries = byHost[bucket] ?? [];
    agents[target] = {
      ...existing,
      allowlist: { ...byHost, [bucket]: entries.map(updateEntry) },
    };
  } else {
    const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
    agents[target] = { ...existing, allowlist: allowlist.map(updateEntry) };
  }

  approvals.agents = agents;
  saveExecApprovals(approvals);
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
  host?: ExecHost,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const trimmed = pattern.trim();
  if (!trimmed) {
    return;
  }
  const newEntry: ExecAllowlistEntry = {
    id: crypto.randomUUID(),
    pattern: trimmed,
    lastUsedAt: Date.now(),
  };

  if (isAllowlistByHost(existing.allowlist)) {
    if (!host) {
      // No host provided — cannot safely add to a per-host map. Skip to avoid corruption.
      return;
    }
    // Per-host map: add to the specific host bucket.
    const byHost = existing.allowlist;
    const entries = byHost[host] ?? [];
    if (entries.some((e) => e.pattern === trimmed)) {
      return;
    }
    agents[target] = {
      ...existing,
      allowlist: { ...byHost, [host]: [...entries, newEntry] },
    };
  } else {
    const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
    if (allowlist.some((entry) => entry.pattern === trimmed)) {
      return;
    }
    agents[target] = { ...existing, allowlist: [...allowlist, newEntry] };
  }

  approvals.agents = agents;
  saveExecApprovals(approvals);
}

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}
