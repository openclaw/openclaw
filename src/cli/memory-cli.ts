import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import {
  clearCortexModeOverride,
  getCortexModeOverride,
  setCortexModeOverride,
  type CortexModeScope,
} from "../memory/cortex-mode-overrides.js";
import {
  ensureCortexGraphInitialized,
  getCortexStatus,
  previewCortexContext,
  type CortexPolicy,
} from "../memory/cortex.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { getMemoryCommandSecretTargetIds } from "./command-secret-targets.js";
import { formatHelpExamples } from "./help-format.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

type CortexCommandOptions = {
  agent?: string;
  graph?: string;
  json?: boolean;
};

type CortexEnableCommandOptions = CortexCommandOptions & {
  mode?: CortexPolicy;
  maxChars?: number;
};

type CortexModeCommandOptions = {
  agent?: string;
  sessionId?: string;
  channel?: string;
  json?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

type LoadedMemoryCommandConfig = {
  config: ReturnType<typeof loadConfig>;
  diagnostics: string[];
};

async function loadMemoryCommandConfig(commandName: string): Promise<LoadedMemoryCommandConfig> {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadConfig(),
    commandName,
    targetIds: getMemoryCommandSecretTargetIds(),
  });
  return {
    config: resolvedConfig,
    diagnostics,
  };
}

function emitMemorySecretResolveDiagnostics(
  diagnostics: string[],
  params?: { json?: boolean },
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const toStderr = params?.json === true;
  for (const entry of diagnostics) {
    const message = theme.warn(`[secrets] ${entry}`);
    if (toStderr) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function withMemoryManagerForAgent(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function runCortexStatus(opts: CortexCommandOptions): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const status = await getCortexStatus({
    workspaceDir,
    graphPath: opts.graph,
  });
  if (opts.json) {
    defaultRuntime.log(JSON.stringify({ agentId, ...status }, null, 2));
    return;
  }
  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const label = (text: string) => muted(`${text}:`);
  const lines = [
    `${heading("Cortex Bridge")} ${muted(`(${agentId})`)}`,
    `${label("CLI")} ${status.available ? success("ready") : warn("unavailable")}`,
    `${label("Graph")} ${status.graphExists ? success("present") : warn("missing")}`,
    `${label("Path")} ${info(shortenHomePath(status.graphPath))}`,
    `${label("Workspace")} ${info(shortenHomePath(status.workspaceDir))}`,
  ];
  if (status.error) {
    lines.push(`${label("Error")} ${warn(status.error)}`);
  }
  defaultRuntime.log(lines.join("\n"));
}

async function runCortexPreview(
  opts: CortexCommandOptions & {
    mode?: CortexPolicy;
    maxChars?: number;
  },
): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  try {
    const preview = await previewCortexContext({
      workspaceDir,
      graphPath: opts.graph,
      policy: opts.mode,
      maxChars: opts.maxChars,
    });
    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ agentId, ...preview }, null, 2));
      return;
    }
    if (!preview.context) {
      defaultRuntime.log("No Cortex context available.");
      return;
    }
    defaultRuntime.log(preview.context);
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function runCortexInit(opts: CortexCommandOptions): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  try {
    const result = await ensureCortexGraphInitialized({
      workspaceDir,
      graphPath: opts.graph,
    });
    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ agentId, workspaceDir, ...result }, null, 2));
      return;
    }
    defaultRuntime.log(
      result.created
        ? `Initialized Cortex graph: ${shortenHomePath(result.graphPath)}`
        : `Cortex graph already present: ${shortenHomePath(result.graphPath)}`,
    );
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function loadWritableMemoryConfig(): Promise<Record<string, unknown> | null> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    defaultRuntime.error(
      "Config invalid. Run `openclaw config validate` or `openclaw doctor` first.",
    );
    process.exitCode = 1;
    return null;
  }
  return structuredClone(snapshot.resolved) as Record<string, unknown>;
}

function parseCortexMode(mode?: string): CortexPolicy {
  if (mode === undefined) {
    return "technical";
  }
  if (mode === "full" || mode === "professional" || mode === "technical" || mode === "minimal") {
    return mode;
  }
  throw new Error(`Invalid Cortex mode: ${mode}`);
}

function normalizeCortexMaxChars(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1_500;
  }
  return Math.min(8_000, Math.max(1, Math.floor(value)));
}

function resolveCortexModeTarget(opts: CortexModeCommandOptions): {
  scope: CortexModeScope;
  targetId: string;
} {
  const sessionId = opts.sessionId?.trim();
  const channelId = opts.channel?.trim();
  if (sessionId && channelId) {
    throw new Error("Choose either --session-id or --channel, not both.");
  }
  if (sessionId) {
    return { scope: "session", targetId: sessionId };
  }
  if (channelId) {
    return { scope: "channel", targetId: channelId };
  }
  throw new Error("Missing target. Use --session-id <id> or --channel <id>.");
}

function updateAgentCortexConfig(params: {
  root: Record<string, unknown>;
  agentId?: string;
  updater: (current: Record<string, unknown>) => Record<string, unknown>;
}): void {
  const agents = ((params.root.agents as Record<string, unknown> | undefined) ??= {});
  if (params.agentId?.trim()) {
    const list = Array.isArray(agents.list) ? (agents.list as Record<string, unknown>[]) : [];
    const index = list.findIndex(
      (entry) => typeof entry.id === "string" && entry.id === params.agentId?.trim(),
    );
    if (index === -1) {
      throw new Error(`Agent not found: ${params.agentId}`);
    }
    const entry = list[index] ?? {};
    list[index] = {
      ...entry,
      cortex: params.updater((entry.cortex as Record<string, unknown> | undefined) ?? {}),
    };
    agents.list = list;
    return;
  }

  const defaults = ((agents.defaults as Record<string, unknown> | undefined) ??= {});
  defaults.cortex = params.updater((defaults.cortex as Record<string, unknown> | undefined) ?? {});
}

async function runCortexEnable(opts: CortexEnableCommandOptions): Promise<void> {
  try {
    const cfg = loadConfig();
    const agentId = resolveAgent(cfg, opts.agent);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const next = await loadWritableMemoryConfig();
    if (!next) {
      return;
    }
    updateAgentCortexConfig({
      root: next,
      agentId: opts.agent,
      updater: (current) => ({
        ...current,
        enabled: true,
        mode: parseCortexMode(opts.mode),
        maxChars: normalizeCortexMaxChars(opts.maxChars),
        ...(opts.graph ? { graphPath: opts.graph } : {}),
      }),
    });
    await writeConfigFile(next);
    const initResult = await ensureCortexGraphInitialized({
      workspaceDir,
      graphPath: opts.graph,
    });

    const scope = opts.agent?.trim() ? `agent ${opts.agent.trim()}` : "agent defaults";
    defaultRuntime.log(
      `Enabled Cortex prompt bridge for ${scope} (${parseCortexMode(opts.mode)}, ${normalizeCortexMaxChars(opts.maxChars)} chars).`,
    );
    defaultRuntime.log(
      initResult.created
        ? `Initialized Cortex graph: ${shortenHomePath(initResult.graphPath)}`
        : `Cortex graph ready: ${shortenHomePath(initResult.graphPath)}`,
    );
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function runCortexDisable(opts: CortexCommandOptions): Promise<void> {
  try {
    const next = await loadWritableMemoryConfig();
    if (!next) {
      return;
    }
    updateAgentCortexConfig({
      root: next,
      agentId: opts.agent,
      updater: (current) => ({
        ...current,
        enabled: false,
      }),
    });
    await writeConfigFile(next);

    const scope = opts.agent?.trim() ? `agent ${opts.agent.trim()}` : "agent defaults";
    defaultRuntime.log(`Disabled Cortex prompt bridge for ${scope}.`);
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function runCortexModeShow(opts: CortexModeCommandOptions): Promise<void> {
  try {
    const cfg = loadConfig();
    const agentId = resolveAgent(cfg, opts.agent);
    const target = resolveCortexModeTarget(opts);
    const override = await getCortexModeOverride({
      agentId,
      sessionId: target.scope === "session" ? target.targetId : undefined,
      channelId: target.scope === "channel" ? target.targetId : undefined,
    });
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            agentId,
            scope: target.scope,
            targetId: target.targetId,
            override,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!override) {
      defaultRuntime.log(`No Cortex mode override for ${target.scope} ${target.targetId}.`);
      return;
    }
    defaultRuntime.log(
      `Cortex mode override for ${target.scope} ${target.targetId}: ${override.mode} (${agentId})`,
    );
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function runCortexModeSet(mode: CortexPolicy, opts: CortexModeCommandOptions): Promise<void> {
  try {
    const cfg = loadConfig();
    const agentId = resolveAgent(cfg, opts.agent);
    const target = resolveCortexModeTarget(opts);
    const next = await setCortexModeOverride({
      agentId,
      scope: target.scope,
      targetId: target.targetId,
      mode: parseCortexMode(mode),
    });
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(next, null, 2));
      return;
    }
    defaultRuntime.log(
      `Set Cortex mode override for ${target.scope} ${target.targetId} to ${next.mode} (${agentId}).`,
    );
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function runCortexModeReset(opts: CortexModeCommandOptions): Promise<void> {
  try {
    const cfg = loadConfig();
    const agentId = resolveAgent(cfg, opts.agent);
    const target = resolveCortexModeTarget(opts);
    const removed = await clearCortexModeOverride({
      agentId,
      scope: target.scope,
      targetId: target.targetId,
    });
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            agentId,
            scope: target.scope,
            targetId: target.targetId,
            removed,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!removed) {
      defaultRuntime.log(`No Cortex mode override found for ${target.scope} ${target.targetId}.`);
      return;
    }
    defaultRuntime.log(`Cleared Cortex mode override for ${target.scope} ${target.targetId}.`);
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    process.exitCode = 1;
  }
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory status");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: managerPurpose,
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw memory status", "Show index and provider status."],
          ["openclaw memory status --deep", "Probe embedding provider readiness."],
          ["openclaw memory index --force", "Force a full reindex."],
          ['openclaw memory search "meeting notes"', "Quick search using positional query."],
          [
            'openclaw memory search --query "deployment" --max-results 20',
            "Limit results for focused troubleshooting.",
          ],
          ["openclaw memory status --json", "Output machine-readable JSON (good for scripts)."],
          ["openclaw memory cortex status", "Check local Cortex bridge availability."],
          [
            "openclaw memory cortex preview --mode technical",
            "Preview filtered Cortex context for the active agent workspace.",
          ],
          [
            "openclaw memory cortex enable --mode technical",
            "Turn on Cortex prompt injection without editing openclaw.json manually.",
          ],
          [
            "openclaw memory cortex mode set minimal --session-id abc123",
            "Override Cortex mode for one OpenClaw session.",
          ],
          [
            "openclaw memory cortex mode set professional --channel slack",
            "Override Cortex mode for a channel surface.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory index");
      emitMemorySecretResolveDiagnostics(diagnostics);
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
              if (qmdIndexSummary) {
                defaultRuntime.log(qmdIndexSummary);
              }
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        queryArg: string | undefined,
        opts: MemoryCommandOptions & {
          query?: string;
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const query = opts.query ?? queryArg;
        if (!query) {
          defaultRuntime.error(
            "Missing search query. Provide a positional query or use --query <text>.",
          );
          process.exitCode = 1;
          return;
        }
        const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory search");
        emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
        const agentId = resolveAgent(cfg, opts.agent);
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );

  const cortex = memory.command("cortex").description("Inspect the local Cortex memory bridge");

  cortex
    .command("status")
    .description("Check Cortex CLI and graph availability")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--graph <path>", "Override Cortex graph path")
    .option("--json", "Print JSON")
    .action(async (opts: CortexCommandOptions) => {
      await runCortexStatus(opts);
    });

  cortex
    .command("preview")
    .description("Preview Cortex context export for the active workspace")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--graph <path>", "Override Cortex graph path")
    .option("--mode <mode>", "Context mode", "technical")
    .option("--max-chars <n>", "Max characters", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        opts: CortexCommandOptions & {
          mode?: CortexPolicy;
          maxChars?: number;
        },
      ) => {
        await runCortexPreview(opts);
      },
    );

  cortex
    .command("init")
    .description("Create the default Cortex graph if it does not exist")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--graph <path>", "Override Cortex graph path")
    .option("--json", "Print JSON")
    .action(async (opts: CortexCommandOptions) => {
      await runCortexInit(opts);
    });

  cortex
    .command("enable")
    .description("Enable Cortex prompt context injection in config")
    .option("--agent <id>", "Apply to a specific agent id instead of agent defaults")
    .option("--graph <path>", "Override Cortex graph path")
    .option("--mode <mode>", "Context mode", "technical")
    .option("--max-chars <n>", "Max characters", (value: string) => Number(value))
    .action(async (opts: CortexEnableCommandOptions) => {
      await runCortexEnable(opts);
    });

  cortex
    .command("disable")
    .description("Disable Cortex prompt context injection in config")
    .option("--agent <id>", "Apply to a specific agent id instead of agent defaults")
    .action(async (opts: CortexCommandOptions) => {
      await runCortexDisable(opts);
    });

  const cortexMode = cortex.command("mode").description("Manage runtime Cortex mode overrides");

  const applyModeTargetOptions = (command: Command) =>
    command
      .option("--agent <id>", "Agent id (default: default agent)")
      .option("--session-id <id>", "Apply override to a specific OpenClaw session")
      .option("--channel <id>", "Apply override to a specific channel or surface")
      .option("--json", "Print JSON");

  applyModeTargetOptions(
    cortexMode.command("show").description("Show the stored Cortex mode override for a target"),
  ).action(async (opts: CortexModeCommandOptions) => {
    await runCortexModeShow(opts);
  });

  applyModeTargetOptions(
    cortexMode.command("reset").description("Clear the stored Cortex mode override for a target"),
  ).action(async (opts: CortexModeCommandOptions) => {
    await runCortexModeReset(opts);
  });

  applyModeTargetOptions(
    cortexMode
      .command("set")
      .description("Set a runtime Cortex mode override for a target")
      .argument("<mode>", "Mode (full|professional|technical|minimal)"),
  ).action(async (mode: CortexPolicy, opts: CortexModeCommandOptions) => {
    await runCortexModeSet(mode, opts);
  });
}
