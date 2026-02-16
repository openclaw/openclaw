import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSendPolicyConfig } from "../config/types.base.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryPostgresConfig,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { resolveUserPath } from "../utils.js";
import { splitShellArgs } from "../utils/shell-argv.js";

export type ResolvedPostgresConfig = {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | "require" | "prefer" | "disable";
  tablePrefix: string;
  embedding: {
    provider: "openai" | "voyage" | "gemini";
    model: string;
    dimensions: number;
  };
  hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
  };
  collections: ResolvedQmdCollection[];
  includeDefaultMemory: boolean;
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  qmd?: ResolvedQmdConfig;
  postgres?: ResolvedPostgresConfig;
};

export type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};

export type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedQmdConfig = {
  command: string;
  searchMode: MemoryQmdSearchMode;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};

const DEFAULT_BACKEND: MemoryBackend = "builtin";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15_000;
const DEFAULT_QMD_TIMEOUT_MS = 4_000;
// Defaulting to `query` can be extremely slow on CPU-only systems (query expansion + rerank).
// Prefer a faster mode for interactive use; users can opt into `query` for best recall.
const DEFAULT_QMD_SEARCH_MODE: MemoryQmdSearchMode = "search";
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_UPDATE_TIMEOUT_MS = 120_000;
const DEFAULT_QMD_EMBED_TIMEOUT_MS = 120_000;
const DEFAULT_QMD_LIMITS: ResolvedQmdLimitsConfig = {
  maxResults: 6,
  maxSnippetChars: 700,
  maxInjectedChars: 4_000,
  timeoutMs: DEFAULT_QMD_TIMEOUT_MS,
};
const DEFAULT_QMD_SCOPE: SessionSendPolicyConfig = {
  default: "deny",
  rules: [
    {
      action: "allow",
      match: { chatType: "direct" },
    },
  ],
};

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

function scopeCollectionBase(base: string, agentId: string): string {
  return `${base}-${sanitizeName(agentId)}`;
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  let name = sanitizeName(base);
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${name}-${suffix}`;
  existing.add(unique);
  return unique;
}

function resolvePath(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

function resolveIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveEmbedIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveDebounceMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_QMD_DEBOUNCE_MS;
}

function resolveTimeoutMs(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveLimits(raw?: MemoryQmdConfig["limits"]): ResolvedQmdLimitsConfig {
  const parsed: ResolvedQmdLimitsConfig = { ...DEFAULT_QMD_LIMITS };
  if (raw?.maxResults && raw.maxResults > 0) {
    parsed.maxResults = Math.floor(raw.maxResults);
  }
  if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) {
    parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
  }
  if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) {
    parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
  }
  if (raw?.timeoutMs && raw.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(raw.timeoutMs);
  }
  return parsed;
}

function resolveSearchMode(raw?: MemoryQmdConfig["searchMode"]): MemoryQmdSearchMode {
  if (raw === "search" || raw === "vsearch" || raw === "query") {
    return raw;
  }
  return DEFAULT_QMD_SEARCH_MODE;
}

function resolveSessionConfig(
  cfg: MemoryQmdConfig["sessions"],
  workspaceDir: string,
): ResolvedQmdSessionConfig {
  const enabled = Boolean(cfg?.enabled);
  const exportDirRaw = cfg?.exportDir?.trim();
  const exportDir = exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : undefined;
  const retentionDays =
    cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : undefined;
  return {
    enabled,
    exportDir,
    retentionDays,
  };
}

function resolveCustomPaths(
  rawPaths: MemoryQmdIndexPath[] | undefined,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!rawPaths?.length) {
    return [];
  }
  const collections: ResolvedQmdCollection[] = [];
  rawPaths.forEach((entry, index) => {
    const trimmedPath = entry?.path?.trim();
    if (!trimmedPath) {
      return;
    }
    let resolved: string;
    try {
      resolved = resolvePath(trimmedPath, workspaceDir);
    } catch {
      return;
    }
    const pattern = entry.pattern?.trim() || "**/*.md";
    const baseName = scopeCollectionBase(entry.name?.trim() || `custom-${index + 1}`, agentId);
    const name = ensureUniqueName(baseName, existing);
    collections.push({
      name,
      path: resolved,
      pattern,
      kind: "custom",
    });
  });
  return collections;
}

function resolveDefaultCollections(
  include: boolean,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!include) {
    return [];
  }
  const entries: Array<{ path: string; pattern: string; base: string }> = [
    { path: workspaceDir, pattern: "MEMORY.md", base: "memory-root" },
    { path: workspaceDir, pattern: "memory.md", base: "memory-alt" },
    { path: path.join(workspaceDir, "memory"), pattern: "**/*.md", base: "memory-dir" },
  ];
  return entries.map((entry) => ({
    name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
    path: entry.path,
    pattern: entry.pattern,
    kind: "memory",
  }));
}

function sanitizeTablePrefix(raw: string | undefined): string {
  const trimmed = raw?.trim() || "openclaw_memory";
  // Only allow alphanumeric + underscores to prevent SQL injection.
  return trimmed.replace(/[^a-zA-Z0-9_]/g, "_") || "openclaw_memory";
}

function resolvePostgresConfig(
  pgCfg: MemoryPostgresConfig | undefined,
  workspaceDir: string,
  agentId: string,
): ResolvedPostgresConfig {
  const nameSet = new Set<string>();
  const includeDefaultMemory = pgCfg?.includeDefaultMemory !== false;
  const collections = [
    ...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, agentId),
    ...resolveCustomPaths(pgCfg?.paths, workspaceDir, nameSet, agentId),
  ];

  return {
    connectionString: pgCfg?.connectionString,
    host: pgCfg?.host,
    port: pgCfg?.port,
    database: pgCfg?.database,
    user: pgCfg?.user,
    password: pgCfg?.password,
    ssl: pgCfg?.ssl,
    tablePrefix: sanitizeTablePrefix(pgCfg?.tablePrefix),
    embedding: {
      provider: pgCfg?.embedding?.provider ?? "voyage",
      model: pgCfg?.embedding?.model ?? "voyage-3-lite",
      dimensions: pgCfg?.embedding?.dimensions ?? 512,
    },
    hybrid: {
      enabled: pgCfg?.hybrid?.enabled !== false,
      vectorWeight: pgCfg?.hybrid?.vectorWeight ?? 0.7,
      textWeight: pgCfg?.hybrid?.textWeight ?? 0.3,
    },
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(pgCfg?.sessions, workspaceDir),
    update: {
      intervalMs: resolveIntervalMs(pgCfg?.update?.interval),
      debounceMs: resolveDebounceMs(pgCfg?.update?.debounceMs),
      onBoot: pgCfg?.update?.onBoot !== false,
      waitForBootSync: pgCfg?.update?.waitForBootSync === true,
      embedIntervalMs: resolveEmbedIntervalMs(pgCfg?.update?.embedInterval),
      commandTimeoutMs: resolveTimeoutMs(
        pgCfg?.update?.commandTimeoutMs,
        DEFAULT_QMD_COMMAND_TIMEOUT_MS,
      ),
      updateTimeoutMs: resolveTimeoutMs(
        pgCfg?.update?.updateTimeoutMs,
        DEFAULT_QMD_UPDATE_TIMEOUT_MS,
      ),
      embedTimeoutMs: resolveTimeoutMs(pgCfg?.update?.embedTimeoutMs, DEFAULT_QMD_EMBED_TIMEOUT_MS),
    },
    limits: resolveLimits(pgCfg?.limits),
    scope: pgCfg?.scope ?? DEFAULT_QMD_SCOPE,
  };
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  if (backend === "postgres") {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    return {
      backend: "postgres",
      citations,
      postgres: resolvePostgresConfig(params.cfg.memory?.postgres, workspaceDir, params.agentId),
    };
  }
  if (backend !== "qmd") {
    return { backend: "builtin", citations };
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const qmdCfg = params.cfg.memory?.qmd;
  const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
  const nameSet = new Set<string>();
  const collections = [
    ...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, params.agentId),
    ...resolveCustomPaths(qmdCfg?.paths, workspaceDir, nameSet, params.agentId),
  ];

  const rawCommand = qmdCfg?.command?.trim() || "qmd";
  const parsedCommand = splitShellArgs(rawCommand);
  const command = parsedCommand?.[0] || rawCommand.split(/\s+/)[0] || "qmd";
  const resolved: ResolvedQmdConfig = {
    command,
    searchMode: resolveSearchMode(qmdCfg?.searchMode),
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(qmdCfg?.sessions, workspaceDir),
    update: {
      intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
      debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
      onBoot: qmdCfg?.update?.onBoot !== false,
      waitForBootSync: qmdCfg?.update?.waitForBootSync === true,
      embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
      commandTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.commandTimeoutMs,
        DEFAULT_QMD_COMMAND_TIMEOUT_MS,
      ),
      updateTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.updateTimeoutMs,
        DEFAULT_QMD_UPDATE_TIMEOUT_MS,
      ),
      embedTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.embedTimeoutMs,
        DEFAULT_QMD_EMBED_TIMEOUT_MS,
      ),
    },
    limits: resolveLimits(qmdCfg?.limits),
    scope: qmdCfg?.scope ?? DEFAULT_QMD_SCOPE,
  };

  return {
    backend: "qmd",
    citations,
    qmd: resolved,
  };
}
