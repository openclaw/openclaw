import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { withProgress, withProgressTotals } from "./progress.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { resolveStateDir } from "../config/paths.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`;
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`;
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) return trimmed;
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) return [trimmed];
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
  }> = [];

  for (const agentId of agentIds) {
    await withManager<MemoryManager>({
      getManager: () => getMemorySearchManager({ cfg, agentId }),
      onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
      onCloseError: (err) =>
        defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
      close: (manager) => manager.close(),
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await manager.sync({
                    reason: "cli",
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) progress.setLabel(syncUpdate.label);
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        allResults.push({ agentId, status, embeddingProbe, indexError });
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
    const { agentId, status, embeddingProbe, indexError } = result;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(
        `(requested: ${status.requestedProvider})`,
      )}`,
      `${label("Model")} ${info(status.model)}`,
      status.sources?.length ? `${label("Sources")} ${info(status.sources.join(", "))}` : null,
      `${label("Indexed")} ${success(`${status.files} files · ${status.chunks} chunks`)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(status.dbPath)}`,
      `${label("Workspace")} ${info(status.workspaceDir)}`,
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
        const counts = `${entry.files} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available
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
        lines.push(`${label("Vector path")} ${info(status.vector.extensionPath)}`);
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
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Memory search tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.clawd.bot/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: (manager) => manager.close(),
          run: async (manager) => {
            try {
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = status.sources.map((source) =>
                  formatSourceLabel(source, status.workspaceDir, agentId),
                );
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${status.requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(status.model)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
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
                if (lastTotal <= 0 || lastCompleted <= 0) return null;
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) return null;
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
                    await manager.sync({
                      reason: "cli",
                      force: opts.force,
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) lastLabel = syncUpdate.label;
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
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: (manager) => manager.close(),
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
                  `${result.path}:${result.startLine}-${result.endLine}`,
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
}
